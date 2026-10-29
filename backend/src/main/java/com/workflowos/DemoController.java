package com.workflowos;

import static com.workflowos.common.Errors.require;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workflowos.Model.*;
import jakarta.persistence.*;
import jakarta.servlet.http.HttpSession;
import java.math.BigDecimal;
import java.util.*;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

/** Opt-in fictional sample. Never invoked at application startup. */
@RestController
@RequestMapping("/api/orgs/{org}/demo")
@Transactional
public class DemoController {
  @PersistenceContext EntityManager em;
  final Access a;
  final ObjectMapper json;

  public DemoController(Access a, ObjectMapper json) {
    this.a = a;
    this.json = json;
  }

  String encode(Object o) {
    try {
      return json.writeValueAsString(o);
    } catch (Exception e) {
      throw new IllegalArgumentException(e);
    }
  }

  @PostMapping
  public Map<String, Object> seed(
      @PathVariable UUID org, @RequestBody Map<String, UUID> b, HttpSession s) {
    a.member(org, s, true);
    UUID loc = b.get("locationId");
    Location l = a.get(Location.class, loc, org);
    em.lock(l, LockModeType.PESSIMISTIC_WRITE);
    require(
        a.list(Template.class, org).stream().noneMatch(t -> t.locationId.equals(loc)),
        "该地点已有模板，请使用空白地点载入示例");
    if (a.list(Variable.class, org).stream()
        .noneMatch(v -> v.variableKey.equals("expected_guests"))) {
      Variable v = new Variable();
      v.organizationId = org;
      v.variableKey = "expected_guests";
      v.name = "预计客流";
      v.unit = "人";
      em.persist(v);
    }
    List<Template> templates = new ArrayList<>();
    String[] names = {
      "检查设备与工作环境", "检查库存与物料", "准备今日食材", "营业前最后检查", "开店与现场准备", "午后补充食材", "清洁设备与工作台", "打烊与交接检查"
    };
    String[] times = {"08:00", "08:15", "08:30", "10:30", "11:00", "15:00", "21:00", "22:00"};
    String[] categories = {"开店流程", "开店流程", "食材准备", "开店流程", "开店流程", "食材准备", "清洁流程", "打烊流程"};
    for (int i = 0; i < names.length; i++) {
      Sop sop = new Sop();
      sop.organizationId = org;
      sop.title = names[i] + " · 标准操作";
      sop.category = categories[i];
      sop.status = "PUBLISHED";
      sop.draft =
          encode(
              List.of(
                  Map.of(
                      "title",
                      "准备工作台和工具",
                      "description",
                      "根据现场要求准备工具，确认工作区域整洁。",
                      "estimatedMinutes",
                      3),
                  Map.of(
                      "title",
                      "检查材料与设备状态",
                      "description",
                      "确认材料状态和设备符合本地点的操作标准。示例不替代实际安全规范。",
                      "safetyNotice",
                      "发现异常时停止操作并报告管理员。",
                      "requiresConfirmation",
                      true),
                  Map.of(
                      "title",
                      "按标准完成并记录",
                      "description",
                      "核对实际完成数量，清理现场并保存执行记录。",
                      "requiresConfirmation",
                      true)));
      em.persist(sop);
      SopVersion v = new SopVersion();
      v.organizationId = org;
      v.sopId = sop.id;
      v.versionNumber = 1;
      v.title = sop.title;
      v.steps = sop.draft;
      v.publishedAt = java.time.Instant.now();
      v.publishedBy = a.user(s);
      em.persist(v);
      em.flush();
      sop.currentVersionId = v.id;
      Template t = new Template();
      t.organizationId = org;
      t.locationId = loc;
      t.name = names[i];
      t.category = categories[i];
      t.startTime = times[i];
      t.durationMinutes = i == 2 ? 90 : 15;
      t.priority = i == 2 ? "HIGH" : "NORMAL";
      t.description = i == 2 ? "按今日预计客流计算建议数量。演示系数需根据实际业务重新配置。" : "按标准操作指引完成检查，并记录现场情况。";
      t.sopId = sop.id;
      if (i == 2) {
        t.quantity = new BigDecimal("0.00");
        t.unit = "kg";
      }
      if (i == 1) t.prerequisites = encode(List.of(templates.get(0).id));
      em.persist(t);
      templates.add(t);
    }
    Rule qty = new Rule();
    qty.organizationId = org;
    qty.locationId = loc;
    qty.name = "演示：按客流计算备料（系数需核实）";
    qty.priority = 10;
    qty.conditionJson = "true";
    qty.actionJson =
        encode(
            List.of(
                Map.of(
                    "type",
                    "SET_QUANTITY",
                    "templateId",
                    templates.get(2).id,
                    "expression",
                    Map.of(
                        "op",
                        "*",
                        "left",
                        Map.of("op", "*", "left", Map.of("var", "expected_guests"), "right", 0.15),
                        "right",
                        1.1),
                    "increment",
                    0.1,
                    "rounding",
                    "UP")));
    em.persist(qty);
    Rule extra = new Rule();
    extra.organizationId = org;
    extra.locationId = loc;
    extra.name = "演示：高客流加一次补料";
    extra.priority = 20;
    extra.conditionJson = "{\"op\":\">\",\"left\":{\"var\":\"expected_guests\"},\"right\":100}";
    extra.actionJson =
        encode(
            List.of(
                Map.of("type", "ADD_TASK", "templateId", templates.get(5).id),
                Map.of("type", "NOTICE", "message", "预计客流较高，请管理员检查人员安排。")));
    em.persist(extra);
    a.audit(org, a.user(s), "DEMO_LOADED", loc, "仅演示数据；所有备料系数必须由用户核实");
    return Map.of("templates", templates.size(), "message", "示例已载入，请设置预计客流并生成计划");
  }
}
