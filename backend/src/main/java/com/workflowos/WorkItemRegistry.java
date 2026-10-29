package com.workflowos;

import static com.workflowos.common.Errors.require;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workflowos.Model.*;
import jakarta.persistence.*;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** A persisted record for each module, independent of canvas layout and instruction documents. */
@Service
@Transactional
public class WorkItemRegistry {
  @PersistenceContext EntityManager em;
  final ObjectMapper json;

  public WorkItemRegistry(ObjectMapper json) {
    this.json = json;
  }

  // Keep compatibility with the frontend's readWorkflow() without rewriting existing drafts.
  static String moduleId(JsonNode step, int rawIndex) {
    String id = step.path("id").asText();
    if (step.path("kind").asText().equals("MODULE"))
      return id.isEmpty() ? "module-" + rawIndex : id;
    return "module-" + (id.isEmpty() ? "legacy-" + rawIndex : id);
  }

  static void validateLayout(JsonNode steps, double canvasWidth, double canvasHeight) {
    Set<String> ids = new HashSet<>();
    int index = 0;
    for (JsonNode step : steps) {
      if (!step.path("kind").asText().equals("DETAIL")) {
        if (step.has("id"))
          require(
              step.path("id").isTextual()
                  && !step.path("id").asText().isBlank()
                  && step.path("id").asText().length() <= 255,
              "工作信息不完整，请重新打开后再保存");
        String id = moduleId(step, index);
        require(id.length() <= 255 && ids.add(id), "工作信息有重复，请重新打开后再保存");
        if (step.has("detailId"))
          require(step.path("detailId").isTextual()
                  && !WorkspaceController.normalizeStepName(step.path("detailId").asText()).isEmpty()
                  && step.path("detailId").asText().length() <= 255,
              "对应做法的信息不完整，请重新选择后再保存");
        if (step.has("frame")) {
          JsonNode frame = step.path("frame");
          require(frame.isObject(), "方框的位置和大小有问题，请重新打开后再保存");
          for (String key : List.of("x", "y", "width", "height")) {
            JsonNode value = frame.path(key);
            require(
                value.isNumber() && Double.isFinite(value.asDouble()),
                "方框的位置和大小有问题，请重新打开后再保存");
          }
          double x = frame.path("x").asDouble(), y = frame.path("y").asDouble();
          double width = frame.path("width").asDouble(), height = frame.path("height").asDouble();
          require(
              x >= 0 && y >= 0
                  && width >= 32 && height >= 32 && width <= 2400 && height <= 2400
                  && x + width <= canvasWidth + 0.000001
                  && y + height <= canvasHeight + 0.000001,
              "方框太小或超出了流程图，请调整后再保存");
        } else {
          double width = 0.2, height = 0.2;
          if (step.has("size")) {
            JsonNode size = step.path("size");
            require(size.isObject(), "方框太小或超出了流程图，请调整后再保存");
            for (String dimension : List.of("width", "height")) {
              JsonNode value = size.path(dimension);
              require(
                  value.isNumber()
                      && Double.isFinite(value.asDouble())
                      && value.asDouble() >= 0.12
                      && value.asDouble() <= 1,
                  "方框太小或超出了流程图，请调整后再保存");
            }
            width = size.path("width").asDouble();
            height = size.path("height").asDouble();
          }
          if (step.has("position")) {
            JsonNode position = step.path("position");
            require(position.isObject(), "工作位置不正确，请重新拖动后再保存");
            for (String coordinate : List.of("x", "y")) {
              JsonNode value = position.path(coordinate);
              require(
                  value.isNumber()
                      && Double.isFinite(value.asDouble())
                      && value.asDouble() >= 0
                      && value.asDouble() + (coordinate.equals("x") ? width : height) <= 1,
                  "方框太小或超出了流程图，请调整后再保存");
            }
          }
        }
      }
      index++;
    }
    index = 0;
    for (JsonNode step : steps) {
      if (!step.path("kind").asText().equals("DETAIL") && step.has("nextModuleIds")) {
        JsonNode connections = step.path("nextModuleIds");
        require(connections.isArray() && connections.size() <= 100, "内容格式有问题，请重新打开后再保存");
        Set<String> targets = new HashSet<>();
        String source = moduleId(step, index);
        for (JsonNode target : connections)
          require(
              target.isTextual()
                  && ids.contains(target.asText())
                  && !source.equals(target.asText())
                  && targets.add(target.asText()),
              "箭头只能连到这个流程里的另一项工作，同一条箭头不能重复添加");
      }
      index++;
    }
  }

  public void synchronize(Sop workflow) {
    JsonNode steps;
    try {
      steps = json.readTree(workflow.draft);
    } catch (Exception e) {
      throw new IllegalArgumentException("内容格式有问题，请重新打开后再保存");
    }
    require(steps != null && steps.isArray(), "内容格式有问题，请重新打开后再保存");
    Map<String, WorkItem> existing = new HashMap<>();
    for (WorkItem item :
        em.createQuery(
                "from WorkItem where organizationId=:org and workflowId=:workflow", WorkItem.class)
            .setParameter("org", workflow.organizationId)
            .setParameter("workflow", workflow.id)
            .getResultList())
      existing.put(item.moduleId, item);

    Set<String> retained = new HashSet<>();
    int index = 0;
    for (JsonNode step : steps) {
      if (!step.path("kind").asText().equals("DETAIL")) {
        String moduleId = moduleId(step, index);
        require(retained.add(moduleId), "工作信息有重复，请重新打开后再保存");
        WorkItem item = existing.get(moduleId);
        String name = WorkspaceController.normalizeStepName(step.path("title").asText());
        if (item == null) {
          item = new WorkItem();
          item.organizationId = workflow.organizationId;
          item.workflowId = workflow.id;
          item.moduleId = moduleId;
          item.name = name;
          em.persist(item);
        } else if (!Objects.equals(item.name, name)) {
          item.name = name;
          item.updatedAt = Instant.now();
        }
      }
      index++;
    }
    for (WorkItem item : existing.values())
      if (!retained.contains(item.moduleId)) em.remove(item);
  }

  public List<WorkItem> list(UUID organizationId) {
    // Lazy backfill locks several workflows; use the same org -> workflow order as draft
    // writes so a cross-workflow instruction rename cannot deadlock against this list.
    em.find(Organization.class, organizationId, LockModeType.PESSIMISTIC_WRITE);
    // Lock each workflow so lazy backfill and a concurrent save cannot create duplicate records.
    List<Sop> workflows =
        em.createQuery(
                "from Sop where organizationId=:org and status<>'ARCHIVED' order by id", Sop.class)
            .setParameter("org", organizationId)
            .setLockMode(LockModeType.PESSIMISTIC_WRITE)
            .getResultList();
    for (Sop workflow : workflows) synchronize(workflow);
    em.flush();
    return em.createQuery(
            "select w from WorkItem w, Sop s where w.workflowId=s.id"
                + " and w.organizationId=:org and s.organizationId=:org"
                + " and s.status<>'ARCHIVED' order by w.createdAt,w.id",
            WorkItem.class)
        .setParameter("org", organizationId)
        .getResultList();
  }
}
