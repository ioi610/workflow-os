package com.workflowos;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.workflowos.Model.*;
import jakarta.persistence.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/** Resolve instruction references using the same local-first rules as the workflow reader. */
@Service
public class WorkflowLinks {
  @PersistenceContext EntityManager em;
  final ObjectMapper json;
  final WorkItemRegistry workItems;

  public WorkflowLinks(ObjectMapper json, WorkItemRegistry workItems) {
    this.json = json;
    this.workItems = workItems;
  }

  // Every workflow draft writer takes this before a workflow lock. This prevents a source
  // deletion from racing a new explicit reference or a rename of its instruction document.
  public void lock(UUID organizationId) {
    em.find(Organization.class, organizationId, LockModeType.PESSIMISTIC_WRITE);
  }

  public List<Sop> library(UUID organizationId) {
    return em.createQuery("from Sop where organizationId=:org order by id", Sop.class)
        .setParameter("org", organizationId).getResultList();
  }

  private record Document(String id, String name) {}
  private record Module(String id, JsonNode value) {}
  private record Snapshot(Sop workflow, JsonNode steps, List<Document> documents, List<Module> modules) {}
  private record Reference(Snapshot source, Document document) {}

  private JsonNode parse(String value) {
    try {
      JsonNode steps = json.readTree(value);
      if (steps == null || !steps.isArray()) throw new IllegalArgumentException();
      return steps;
    } catch (Exception e) {
      throw new ResponseStatusException(HttpStatus.CONFLICT,
          "有流程的内容暂时无法读取，请先重新打开检查后再试");
    }
  }

  private List<Document> documents(JsonNode steps) {
    List<Document> result = new ArrayList<>();
    int index = 0;
    for (JsonNode step : steps) {
      String kind = step.path("kind").asText();
      if (!kind.equals("MODULE")) {
        JsonNode rawId = step.path("id");
        String id;
        if (kind.equals("DETAIL")) {
          id = rawId.isTextual() ? rawId.asText() : null;
          if (rawId.isMissingNode() || rawId.isNull() || "".equals(id)) id = "detail-" + index;
        } else {
          String legacyId = rawId.asText();
          id = "detail-" + (legacyId.isEmpty() ? "legacy-" + index : legacyId);
        }
        result.add(new Document(id, name(step.path("title").asText())));
      }
      index++;
    }
    return result;
  }

  private List<Module> modules(JsonNode steps) {
    List<Module> result = new ArrayList<>();
    int index = 0;
    for (JsonNode step : steps) {
      if (!step.path("kind").asText().equals("DETAIL"))
        result.add(new Module(WorkItemRegistry.moduleId(step, index), step));
      index++;
    }
    return result;
  }

  private List<Snapshot> snapshots(List<Sop> library) {
    return library.stream().map(workflow -> {
      JsonNode steps = parse(workflow.draft);
      return new Snapshot(workflow, steps, documents(steps), modules(steps));
    }).toList();
  }

  private static String name(String value) {
    return WorkspaceController.normalizeStepName(value);
  }

  private String lookupName(JsonNode module) {
    JsonNode alias = module.path("detailName");
    return alias.isTextual() && !name(alias.asText()).isEmpty()
        ? name(alias.asText()) : name(module.path("title").asText());
  }

  private List<Document> matches(Snapshot source, JsonNode module) {
    JsonNode id = module.path("detailId");
    return source.documents.stream()
        .filter(document -> id.isTextual()
            ? Objects.equals(document.id, id.asText())
            : document.name.equals(lookupName(module)))
        .toList();
  }

  private Reference resolve(Snapshot owner, JsonNode module, List<Snapshot> library) {
    JsonNode sourceId = module.path("detailWorkflowId");
    if (sourceId.isTextual()) {
      Snapshot source = library.stream()
          .filter(item -> item.workflow.id.toString().equals(sourceId.asText()))
          .findFirst().orElse(null);
      if (source == null) return null;
      List<Document> matches = matches(source, module);
      return matches.size() == 1 ? new Reference(source, matches.getFirst()) : null;
    }
    List<Document> local = matches(owner, module);
    // An explicit document ID never falls back to an unrelated same-name document.
    if (module.path("detailId").isTextual() || !local.isEmpty())
      return local.size() == 1 ? new Reference(owner, local.getFirst()) : null;
    List<Reference> candidates = library.stream()
        .filter(source -> !source.workflow.id.equals(owner.workflow.id))
        .flatMap(source -> matches(source, module).stream()
            .map(document -> new Reference(source, document)))
        .toList();
    return candidates.size() == 1 ? candidates.getFirst() : null;
  }

  private boolean sameBinding(JsonNode before, JsonNode after) {
    return before.path("detailWorkflowId").equals(after.path("detailWorkflowId"))
        && before.path("detailId").equals(after.path("detailId"));
  }

  private JsonNode materializeIds(JsonNode steps, Set<String> wanted) {
    JsonNode result = steps.deepCopy();
    boolean changed = false;
    int index = 0;
    for (JsonNode step : result) {
      String kind = step.path("kind").asText();
      if (step instanceof ObjectNode object && !kind.equals("MODULE")) {
        JsonNode id = step.path("id");
        boolean absent = id.isMissingNode() || id.isNull() || id.isTextual() && id.asText().isEmpty();
        String fallback = kind.equals("DETAIL") ? "detail-" + index : "detail-legacy-" + index;
        if (absent && wanted.contains(fallback)) {
          // A raw legacy row is both a module and a document. Keeping its old raw
          // fallback as the ID preserves both reader IDs and the existing work record.
          object.put("id", kind.equals("DETAIL") ? fallback : "legacy-" + index);
          changed = true;
        }
      }
      index++;
    }
    return changed ? result : steps;
  }

  public JsonNode materializeBoundDocuments(Sop workflow, JsonNode incoming, List<Sop> library) {
    Map<UUID, Set<String>> wanted = new HashMap<>();
    for (Module module : modules(incoming)) {
      JsonNode detailId = module.value.path("detailId");
      if (!detailId.isTextual()) continue;
      JsonNode sourceId = module.value.path("detailWorkflowId");
      Sop source = sourceId.isTextual() && !sourceId.asText().equals(workflow.id.toString())
          ? library.stream().filter(item -> item.id.toString().equals(sourceId.asText()))
              .findFirst().orElse(null)
          : workflow;
      if (source == null) continue; // Preserve an already broken binding without guessing.
      JsonNode sourceSteps = source.id.equals(workflow.id) ? incoming : parse(source.draft);
      if (documents(sourceSteps).stream().filter(document -> Objects.equals(document.id, detailId.asText()))
          .count() == 1)
        wanted.computeIfAbsent(source.id, ignored -> new HashSet<>()).add(detailId.asText());
    }
    for (Sop source : library) {
      if (source.id.equals(workflow.id) || !wanted.containsKey(source.id)) continue;
      JsonNode before = parse(source.draft);
      JsonNode stable = materializeIds(before, wanted.get(source.id));
      if (stable != before) {
        source.draft = stable.toString();
        workItems.synchronize(source);
      }
    }
    return wanted.containsKey(workflow.id) ? materializeIds(incoming, wanted.get(workflow.id)) : incoming;
  }

  public void validateBindings(Sop workflow, JsonNode incoming, List<Sop> library) {
    Map<String, JsonNode> before = new HashMap<>();
    for (Module module : modules(parse(workflow.draft))) before.put(module.id, module.value);
    for (Module module : modules(incoming)) {
      JsonNode value = module.value;
      JsonNode sourceId = value.path("detailWorkflowId"), detailId = value.path("detailId");
      if (!sourceId.isTextual() && !detailId.isTextual()) continue;
      JsonNode old = before.get(module.id);
      if (old != null && sameBinding(old, value)) continue;
      Sop source = sourceId.isTextual() && !sourceId.asText().equals(workflow.id.toString())
          ? library.stream().filter(item -> item.id.toString().equals(sourceId.asText()))
              .findFirst().orElse(null)
          : workflow;
      if (source == null)
        throw new ResponseStatusException(HttpStatus.CONFLICT,
            "这份做法的来源已经不存在或不在当前工作内容中，请重新选择");
      JsonNode sourceSteps = source.id.equals(workflow.id) ? incoming : parse(source.draft);
      if (detailId.isTextual() && documents(sourceSteps).stream()
          .filter(document -> Objects.equals(document.id, detailId.asText())).count() != 1)
        throw new ResponseStatusException(HttpStatus.CONFLICT,
            "这份具体做法已经不存在，请重新选择");
    }
  }

  public List<String> dependents(Sop source, List<Sop> library) {
    List<Snapshot> snapshots = snapshots(library);
    List<String> result = new ArrayList<>();
    for (Snapshot owner : snapshots) {
      if (owner.workflow.id.equals(source.id)) continue;
      List<String> work = owner.modules.stream().filter(module -> {
        JsonNode value = module.value;
        if (value.path("detailWorkflowId").isTextual())
          return value.path("detailWorkflowId").asText().equals(source.id.toString());
        Reference reference = resolve(owner, value, snapshots);
        return reference != null && reference.source.workflow.id.equals(source.id);
      }).map(module -> module.value.path("title").asText()).toList();
      if (!work.isEmpty()) result.add(owner.workflow.title + "（" + String.join("、", work) + "）");
    }
    return result;
  }

  public void validateRemovedDetails(Sop source, JsonNode incoming, List<Sop> library) {
    List<Snapshot> snapshots = snapshots(library);
    Snapshot previous = snapshots.stream().filter(item -> item.workflow.id.equals(source.id))
        .findFirst().orElse(null);
    if (previous == null) return;
    Set<String> retained = new HashSet<>();
    for (Document document : documents(incoming)) retained.add(document.id);
    Set<String> removed = new HashSet<>();
    for (Document document : previous.documents)
      if (!retained.contains(document.id)) removed.add(document.id);
    if (removed.isEmpty()) return;
    List<String> dependents = new ArrayList<>();
    for (Snapshot owner : snapshots) {
      Set<String> oldModuleIds = new HashSet<>();
      for (Module module : owner.modules) oldModuleIds.add(module.id);
      List<Module> proposed = owner.workflow.id.equals(source.id)
          ? modules(incoming).stream().filter(module -> oldModuleIds.contains(module.id)).toList()
          : owner.modules;
      List<String> work = proposed.stream().filter(module -> {
        Reference reference = resolve(owner, module.value, snapshots);
        return reference != null && reference.source.workflow.id.equals(source.id)
            && removed.contains(reference.document.id);
      }).map(module -> module.value.path("title").asText()).toList();
      if (!work.isEmpty()) dependents.add(owner.workflow.title + "（" + String.join("、", work) + "）");
    }
    if (!dependents.isEmpty())
      throw new ResponseStatusException(HttpStatus.CONFLICT,
          "这些工作还在使用要移除的做法，暂时不能删除：「" + String.join("」、「", dependents)
              + "」。请先更换或移除对应工作");
  }

  public JsonNode preserveRenamedReferences(Sop source, JsonNode incoming, List<Sop> library) {
    List<Snapshot> snapshots = snapshots(library);
    Snapshot previous = snapshots.stream().filter(item -> item.workflow.id.equals(source.id))
        .findFirst().orElse(null);
    if (previous == null) return incoming;
    Map<String, Document> next = new HashMap<>();
    for (Document document : documents(incoming))
      if (document.id != null) next.put(document.id, document);
    Set<String> renamed = new HashSet<>();
    for (Document document : previous.documents) {
      Document changed = next.get(document.id);
      if (changed != null && !document.name.equals(changed.name)) renamed.add(document.id);
    }
    if (renamed.isEmpty()) return incoming;
    incoming = materializeIds(incoming, renamed);
    for (Snapshot owner : snapshots) {
      JsonNode steps = owner.workflow.id.equals(source.id) ? incoming.deepCopy() : owner.steps.deepCopy();
      Map<String, JsonNode> updated = new HashMap<>();
      for (Module module : modules(steps)) updated.put(module.id, module.value);
      boolean changed = false;
      for (Module module : owner.modules) {
        if (module.value.path("detailId").isTextual()) continue;
        Reference reference = resolve(owner, module.value, snapshots);
        if (reference == null || !reference.source.workflow.id.equals(source.id)
            || !renamed.contains(reference.document.id)) continue;
        JsonNode value = updated.get(module.id);
        if (!(value instanceof ObjectNode object) || value.path("detailId").isTextual()
            || !sameBinding(module.value, value)) continue;
        String requestedName = lookupName(value);
        if (!requestedName.equals(reference.document.name)
            && !requestedName.equals(next.get(reference.document.id).name)) continue;
        object.put("detailWorkflowId", source.id.toString());
        object.put("detailId", reference.document.id);
        changed = true;
      }
      if (changed) {
        if (owner.workflow.id.equals(source.id)) incoming = steps;
        else {
          owner.workflow.draft = steps.toString();
          workItems.synchronize(owner.workflow);
        }
      }
    }
    return incoming;
  }
}
