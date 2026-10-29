package com.workflowos;

import static com.workflowos.common.Errors.require;

import com.fasterxml.jackson.databind.*;
import com.workflowos.Model.*;
import com.workflowos.ruleengine.RuleEngine;
import jakarta.persistence.*;
import jakarta.servlet.http.HttpSession;
import java.math.BigDecimal;
import java.time.*;
import java.util.*;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orgs/{org}")
@Transactional
public class PlanningController {
  @PersistenceContext EntityManager em;
  final Access a;
  final ObjectMapper json;

  public PlanningController(Access a, ObjectMapper j) {
    this.a = a;
    json = j;
  }

  String encode(Object o) {
    try {
      return json.writeValueAsString(o);
    } catch (Exception e) {
      throw new IllegalArgumentException("JSON 无效");
    }
  }

  JsonNode parse(String s) {
    try {
      return json.readTree(s);
    } catch (Exception e) {
      throw new IllegalArgumentException("JSON 无效");
    }
  }

  @GetMapping("/plans")
  public Map<String, Object> plan(
      @PathVariable UUID org,
      @RequestParam UUID locationId,
      @RequestParam(required = false) LocalDate date,
      HttpSession s) {
    a.member(org, s, false);
    Location l = a.get(Location.class, locationId, org);
    LocalDate day = date == null ? LocalDate.now(ZoneId.of(l.timezone)) : date;
    Plan p =
        em.createQuery(
                "from Plan where organizationId=:o and locationId=:l and businessDate=:d",
                Plan.class)
            .setParameter("o", org)
            .setParameter("l", locationId)
            .setParameter("d", day)
            .getResultStream()
            .findFirst()
            .orElse(null);
    Map<String, Object> result = new LinkedHashMap<>();
    result.put("businessDate", day);
    result.put("plan", p);
    result.put("tasks", p == null ? List.of() : tasks(org, p.id));
    return result;
  }

  List<Task> tasks(UUID org, UUID plan) {
    return em.createQuery(
            "from Task where organizationId=:o and planId=:p order by plannedStartAt,sourceKey",
            Task.class)
        .setParameter("o", org)
        .setParameter("p", plan)
        .getResultList();
  }

  public record Generate(UUID locationId, LocalDate date, Map<String, BigDecimal> variables) {}

  void validateVariables(UUID org, Map<String, BigDecimal> vars) {
    require(vars != null && vars.size() <= 100, "业务参数无效");
    Set<String> keys = new HashSet<>();
    a.list(Variable.class, org).forEach(v -> keys.add(v.variableKey));
    vars.forEach(
        (k, v) ->
            require(
                keys.contains(k)
                    && v != null
                    && v.abs().compareTo(new BigDecimal("1000000000000")) <= 0
                    && v.scale() <= 8,
                "未知变量或数值无效：" + k));
  }

  Plan lockPlan(UUID org, Generate b) {
    Location l = a.get(Location.class, b.locationId, org);
    em.lock(l, LockModeType.PESSIMISTIC_WRITE);
    require(b.date != null, "业务日期必填");
    return em.createQuery(
            "from Plan where organizationId=:o and locationId=:l and businessDate=:d", Plan.class)
        .setParameter("o", org)
        .setParameter("l", b.locationId)
        .setParameter("d", b.date)
        .getResultStream()
        .findFirst()
        .orElseGet(
            () -> {
              Plan p = new Plan();
              p.organizationId = org;
              p.locationId = b.locationId;
              p.businessDate = b.date;
              em.persist(p);
              return p;
            });
  }

  boolean applicable(Template t, LocalDate d) {
    JsonNode r = parse(t.recurrence);
    return switch (r.path("type").asText()) {
      case "DAILY" -> true;
      case "WEEKDAYS" -> {
        boolean hit = false;
        for (JsonNode day : r.path("days")) hit |= day.asInt() == d.getDayOfWeek().getValue();
        yield hit;
      }
      case "RANGE" ->
          !d.isBefore(LocalDate.parse(r.path("start").asText()))
              && !d.isAfter(LocalDate.parse(r.path("end").asText()));
      default -> throw new IllegalArgumentException("无效重复规则");
    };
  }

  record Candidate(Template template, BigDecimal quantity) {}

  record Calculation(LinkedHashMap<String, Candidate> candidates, List<String> notices) {}

  Calculation calculate(UUID org, Plan p, Map<String, BigDecimal> vars) {
    Location l = a.get(Location.class, p.locationId, org);
    Map<UUID, Template> templates = new HashMap<>();
    LinkedHashMap<String, Candidate> out = new LinkedHashMap<>();
    List<String> notices = new ArrayList<>();
    a.list(Template.class, org).stream()
        .filter(t -> t.active && t.locationId.equals(l.id))
        .sorted(Comparator.comparing(t -> t.id.toString()))
        .forEach(
            t -> {
              templates.put(t.id, t);
              if (applicable(t, p.businessDate))
                out.put(t.id.toString(), new Candidate(t, t.quantity));
            });
    List<Rule> rules =
        a.list(Rule.class, org).stream()
            .filter(r -> r.enabled && r.locationId.equals(l.id))
            .sorted(
                Comparator.comparingInt((Rule r) -> r.priority).thenComparing(r -> r.id.toString()))
            .toList();
    for (Rule r : rules) {
      if (!RuleEngine.matches(parse(r.conditionJson), vars)) continue;
      int i = 0;
      for (JsonNode act : parse(r.actionJson)) {
        String type = act.path("type").asText();
        if (type.equals("NOTICE")) {
          notices.add(act.path("message").asText());
          continue;
        }
        Template t = templates.get(UUID.fromString(act.path("templateId").asText()));
        require(t != null, "规则引用了停用或不存在的模板");
        if (type.equals("SET_QUANTITY")) {
          String key = t.id.toString();
          if (out.containsKey(key)) out.put(key, new Candidate(t, RuleEngine.quantity(act, vars)));
        } else if (type.equals("ADD_TASK")) {
          out.put(
              "rule:" + r.id + ":" + (i++),
              new Candidate(
                  t, act.has("expression") ? RuleEngine.quantity(act, vars) : t.quantity));
        } else throw new IllegalArgumentException("无效规则动作");
      }
    }
    return new Calculation(out, notices);
  }

  Task instantiate(UUID org, Plan p, String key, Candidate c) {
    Template t = c.template;
    Location l = a.get(Location.class, p.locationId, org);
    Task task = new Task();
    task.organizationId = org;
    task.planId = p.id;
    task.templateId = t.id;
    task.sourceKey = key;
    task.title = t.name;
    task.description = t.description;
    task.priority = t.priority;
    task.assignedUserId = t.assignedUserId;
    task.unit = t.unit;
    task.plannedQuantity = c.quantity;
    task.suggestedQuantity = c.quantity;
    task.prerequisites = t.prerequisites;
    task.plannedStartAt =
        p.businessDate
            .atTime(LocalTime.parse(t.startTime))
            .atZone(ZoneId.of(l.timezone))
            .toInstant();
    task.plannedEndAt = task.plannedStartAt.plusSeconds(t.durationMinutes * 60L);
    if (t.sopId != null) {
      Sop sop = a.get(Sop.class, t.sopId, org);
      require(sop.status.equals("PUBLISHED") && sop.currentVersionId != null, "任务关联的 SOP 尚未发布或已归档");
      task.sopVersionId = sop.currentVersionId;
    }
    return task;
  }

  @PostMapping("/plans/generate")
  public Map<String, Object> generate(
      @PathVariable UUID org, @RequestBody Generate b, HttpSession s) {
    a.member(org, s, true);
    validateVariables(org, b.variables);
    Plan p = lockPlan(org, b);
    if (p.generatedAt != null)
      return Map.of("plan", p, "tasks", tasks(org, p.id), "notices", List.of("计划已存在，调整参数请使用重算"));
    Calculation calc = calculate(org, p, b.variables);
    calc.candidates.forEach((key, c) -> em.persist(instantiate(org, p, key, c)));
    p.variables = encode(b.variables);
    p.generatedAt = Instant.now();
    p.status = "GENERATED";
    a.audit(org, a.user(s), "PLAN_GENERATE", p.id, p.variables);
    em.flush();
    return Map.of("plan", p, "tasks", tasks(org, p.id), "notices", calc.notices);
  }

  public record Recalculate(
      Map<String, BigDecimal> variables,
      boolean apply,
      boolean confirmInProgress,
      Long expectedRevision,
      String previewToken) {}

  @PostMapping("/plans/{id}/recalculate")
  public Map<String, Object> recalculate(
      @PathVariable UUID org, @PathVariable UUID id, @RequestBody Recalculate b, HttpSession s) {
    a.member(org, s, true);
    Plan p = a.get(Plan.class, id, org);
    em.lock(p, LockModeType.PESSIMISTIC_WRITE);
    validateVariables(org, b.variables);
    require(p.generatedAt != null, "请先生成每日计划");
    require(
        !b.apply || (b.expectedRevision != null && b.expectedRevision == p.revision),
        "计划已变化，请重新预览");
    Calculation calc = calculate(org, p, b.variables);
    List<Map<String, Object>> diffs = new ArrayList<>();
    Map<String, Task> existing = new HashMap<>();
    for (Task t : tasks(org, id)) {
      em.lock(t, LockModeType.PESSIMISTIC_WRITE);
      existing.put(t.sourceKey, t);
    }
    List<Object> state = new ArrayList<>();
    state.add(p.revision);
    state.add(new TreeMap<>(b.variables));
    existing.values().stream()
        .sorted(Comparator.comparing(t -> t.id.toString()))
        .forEach(state::add);
    calc.candidates.forEach(
        (key, c) -> {
          state.add(key);
          state.add(c.template);
          state.add(c.quantity == null ? "" : c.quantity);
          if (c.template.sopId != null) state.add(a.get(Sop.class, c.template.sopId, org));
        });
    state.add(calc.notices);
    String previewToken = WorkspaceController.hash(encode(state));
    require(!b.apply || previewToken.equals(b.previewToken), "任务、模板或规则已变化，请重新预览差异");
    calc.candidates.forEach(
        (key, c) -> {
          Task t = existing.get(key);
          if (t == null) {
            diffs.add(diff(key, c.template.name, null, c.quantity, "ADD"));
            if (b.apply) em.persist(instantiate(org, p, key, c));
            return;
          }
          String policy =
              t.quantityLocked
                  ? "LOCKED"
                  : Set.of("COMPLETED", "SKIPPED").contains(t.status)
                      ? "PROTECTED"
                      : t.status.equals("IN_PROGRESS") && !b.confirmInProgress
                          ? "NEEDS_CONFIRMATION"
                          : "UPDATE";
          if (!Objects.equals(t.suggestedQuantity, c.quantity)
              || !Objects.equals(t.plannedQuantity, c.quantity)) {
            diffs.add(diff(key, t.title, t.plannedQuantity, c.quantity, policy));
            if (b.apply && policy.equals("NEEDS_CONFIRMATION"))
              throw new IllegalArgumentException("进行中的任务需要管理员确认");
            if (b.apply && policy.equals("UPDATE")) {
              a.audit(
                  org,
                  a.user(s),
                  "QUANTITY_RECALCULATE",
                  t.id,
                  encode(diff(key, t.title, t.plannedQuantity, c.quantity, policy)));
              t.suggestedQuantity = c.quantity;
              t.plannedQuantity = c.quantity;
            }
          }
        });
    for (Task t : existing.values())
      if (!calc.candidates.containsKey(t.sourceKey))
        diffs.add(diff(t.sourceKey, t.title, t.plannedQuantity, null, "KEEP_EXISTING"));
    if (b.apply) {
      p.variables = encode(b.variables);
      a.audit(
          org,
          a.user(s),
          "PLAN_RECALCULATE",
          id,
          encode(Map.of("variables", b.variables, "diffs", diffs)));
      em.flush();
    }
    return Map.of(
        "diffs",
        diffs,
        "notices",
        calc.notices,
        "revision",
        p.revision,
        "applied",
        b.apply,
        "previewToken",
        previewToken);
  }

  Map<String, Object> diff(
      String key, String title, BigDecimal before, BigDecimal after, String policy) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("key", key);
    m.put("title", title);
    m.put("before", before);
    m.put("after", after);
    m.put("policy", policy);
    return m;
  }

  @GetMapping("/tasks/{id}")
  public Map<String, Object> detail(@PathVariable UUID org, @PathVariable UUID id, HttpSession s) {
    a.member(org, s, false);
    Task t = a.get(Task.class, id, org);
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("task", t);
    m.put("sop", t.sopVersionId == null ? null : a.get(SopVersion.class, t.sopVersionId, org));
    m.put(
        "logs",
        em.createQuery(
                "from Log where organizationId=:o and taskId=:t order by createdAt", Log.class)
            .setParameter("o", org)
            .setParameter("t", id)
            .getResultList());
    return m;
  }

  public record Execute(
      String action,
      String requestKey,
      List<Integer> confirmations,
      BigDecimal actualQuantity,
      BigDecimal plannedQuantity,
      String note,
      String photoUrl) {}

  @PostMapping("/tasks/{id}/execute")
  public Task execute(
      @PathVariable UUID org, @PathVariable UUID id, @RequestBody Execute b, HttpSession s) {
    Member member = a.member(org, s, false);
    Task t = a.get(Task.class, id, org);
    em.lock(t, LockModeType.PESSIMISTIC_WRITE);
    UUID uid = a.user(s);
    require(
        !member.role.equals("EMPLOYEE") || t.assignedUserId == null || t.assignedUserId.equals(uid),
        "只能操作分配给自己的任务");
    require(
        b.requestKey != null && b.requestKey.length() >= 16 && b.requestKey.length() <= 100,
        "缺少幂等请求键");
    Log old =
        em.createQuery("from Log where organizationId=:o and requestKey=:k", Log.class)
            .setParameter("o", org)
            .setParameter("k", b.requestKey)
            .getResultStream()
            .findFirst()
            .orElse(null);
    if (old != null) {
      require(
          old.taskId.equals(id) && old.actorId.equals(uid) && old.details.equals(encode(b)),
          "请求键已用于其他操作");
      return t;
    }
    require(!Set.of("COMPLETED", "SKIPPED").contains(t.status), "任务已结束");
    List<Integer> checks = b.confirmations == null ? new ArrayList<>() : b.confirmations;
    JsonNode steps =
        t.sopVersionId == null
            ? json.createArrayNode()
            : parse(a.get(SopVersion.class, t.sopVersionId, org).steps);
    for (int n : checks) require(n >= 0 && n < steps.size(), "步骤索引无效");
    switch (b.action == null ? "" : b.action) {
      case "START" -> {
        require(Set.of("TODO", "BLOCKED").contains(t.status), "当前状态不能开始");
        for (JsonNode dep : parse(t.prerequisites)) {
          require(
              tasks(org, t.planId).stream()
                  .anyMatch(
                      d ->
                          dep.asText().equals(d.templateId == null ? "" : d.templateId.toString())
                              && d.status.equals("COMPLETED")),
              "前置任务尚未完成或未生成");
        }
        t.status = "IN_PROGRESS";
      }
      case "CONFIRM" -> {
        require(t.status.equals("IN_PROGRESS"), "请先开始任务");
        t.confirmations = encode(checks);
      }
      case "COMPLETE" -> {
        require(t.status.equals("IN_PROGRESS"), "请先开始任务");
        for (int i = 0; i < steps.size(); i++)
          if (steps.get(i).path("requiresConfirmation").asBoolean())
            require(checks.contains(i), "请确认所有关键步骤");
        require(t.plannedQuantity == null || b.actualQuantity != null, "请填写实际完成数量");
        require(b.actualQuantity == null || b.actualQuantity.signum() >= 0, "实际数量不能为负");
        t.confirmations = encode(checks);
        t.actualQuantity = b.actualQuantity;
        t.status = "COMPLETED";
        t.completedAt = Instant.now();
      }
      case "BLOCK", "SKIP" -> {
        require(b.note != null && !b.note.isBlank(), "请填写异常或跳过原因");
        t.status = b.action.equals("BLOCK") ? "BLOCKED" : "SKIPPED";
      }
      case "NOTE" -> require(b.note != null && !b.note.isBlank(), "备注不能为空");
      case "QUANTITY" -> {
        require(!member.role.equals("EMPLOYEE"), "需要管理员权限");
        require(
            b.plannedQuantity != null
                && b.plannedQuantity.signum() >= 0
                && b.note != null
                && !b.note.isBlank(),
            "请输入工作量及修改原因");
        a.audit(
            org,
            uid,
            "MANUAL_QUANTITY",
            id,
            encode(diff(t.sourceKey, t.title, t.plannedQuantity, b.plannedQuantity, "LOCKED")));
        t.plannedQuantity = b.plannedQuantity;
        t.quantityLocked = true;
      }
      default -> throw new IllegalArgumentException("不支持的操作");
    }
    require(
        b.photoUrl == null
            || b.photoUrl.isEmpty()
            || b.photoUrl.startsWith("https://")
            || b.photoUrl.startsWith("/api/orgs/" + org + "/files/"),
        "照片链接必须使用 HTTPS");
    Log log = new Log();
    log.organizationId = org;
    log.taskId = id;
    log.actorId = uid;
    log.action = b.action;
    log.requestKey = b.requestKey;
    log.details = encode(b);
    em.persist(log);
    return t;
  }
}
