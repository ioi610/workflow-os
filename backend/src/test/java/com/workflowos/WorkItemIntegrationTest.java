package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:work-items;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
})
@AutoConfigureMockMvc
class WorkItemIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate jdbc;
  MockHttpSession session;
  String base;
  UUID userId;

  @BeforeEach
  void workspace() throws Exception {
    session = new MockHttpSession();
    postJson("/api/auth/register", Map.of(
        "email", UUID.randomUUID() + "@test.com", "password", "SecurePass123!", "displayName", "工作作者"), 200);
    userId = (UUID) session.getAttribute("userId");
    base = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "工作记录"), 200).path("id").asText();
  }

  JsonNode request(MockHttpServletRequestBuilder builder, int expected) throws Exception {
    var response = mvc.perform(builder.session(session).with(csrf()).contentType("application/json"))
        .andReturn().getResponse();
    assertEquals(expected, response.getStatus(), response.getContentAsString());
    return response.getContentAsByteArray().length == 0 ? json.nullNode() : json.readTree(response.getContentAsString());
  }

  JsonNode postJson(String path, Object body, int expected) throws Exception {
    return request(post(path).content(json.writeValueAsString(body)), expected);
  }

  JsonNode notes(String id, String value, int expected) throws Exception {
    return request(put(base + "/work-items/" + id).content(json.writeValueAsString(Map.of("notes", value))), expected);
  }

  ObjectNode module(String id, String name) {
    return json.createObjectNode().put("kind", "MODULE").put("id", id).put("title", name);
  }

  ObjectNode detail(String name) {
    ObjectNode detail = json.createObjectNode().put("kind", "DETAIL").put("title", name);
    detail.putArray("items").addObject().put("text", "手动编写的详细做法");
    return detail;
  }

  ObjectNode body(JsonNode steps) {
    ObjectNode body = json.createObjectNode().put("title", "工作流程").put("category", "日常");
    body.set("steps", steps);
    return body;
  }

  ObjectNode edit(JsonNode saved, JsonNode steps) {
    return body(steps).put("id", saved.path("id").asText())
        .put("expectedRevision", saved.path("revision").asLong());
  }

  JsonNode items() throws Exception {
    return request(get(base + "/work-items"), 200);
  }

  JsonNode item(JsonNode items, String moduleId) {
    for (JsonNode item : items)
      if (item.path("moduleId").asText().equals(moduleId)) return item;
    throw new AssertionError("缺少模块工作记录 " + moduleId);
  }

  @Test
  void everyModuleCreatesOnePersistedRecordAndNotesSurviveRenameMoveAndRepeatedSave() throws Exception {
    ObjectNode first = module("module-a", " 开始工作 ");
    ObjectNode second = module("module-b", "检查设备");
    first.putObject("position").put("x", 0.13).put("y", 0.27);
    first.putArray("nextModuleIds").add("module-b");
    ArrayNode steps = json.createArrayNode().add(first).add(second).add(detail("开始工作"));
    JsonNode saved = postJson(base + "/sops/save", body(steps), 200);
    UUID workflowId = UUID.fromString(saved.path("id").asText());
    assertEquals(2, jdbc.queryForObject("select count(*) from work_items where workflow_id=?", Integer.class, workflowId));
    JsonNode original = item(items(), "module-a");
    assertEquals("开始工作", original.path("name").asText());
    assertEquals(saved.path("id"), original.path("workflowId"));
    assertEquals("", original.path("notes").asText());
    String recordId = original.path("id").asText();
    JsonNode noted = notes(recordId, "独立保存的工作备注\n第二行", 200);
    assertEquals("独立保存的工作备注\n第二行", noted.path("notes").asText());
    assertEquals(saved.path("draft"), request(get(base + "/sops"), 200).get(0).path("draft"));

    first.put("title", "开机并检查");
    first.putObject("position").put("x", 0.7).put("y", 0.6);
    ArrayNode reordered = json.createArrayNode().add(second).add(first).add(detail("开机并检查"));
    JsonNode changed = postJson(base + "/sops/save", edit(saved, reordered), 200);
    JsonNode renamed = item(items(), "module-a");
    assertEquals(recordId, renamed.path("id").asText());
    assertEquals("开机并检查", renamed.path("name").asText());
    assertEquals(noted.path("notes"), renamed.path("notes"));
    ArrayNode canonical = (ArrayNode) json.readTree(changed.path("draft").asText());
    JsonNode repeated = postJson(base + "/sops/save", edit(changed, canonical), 200);
    assertEquals(changed, repeated);
    assertEquals("detail-2", canonical.get(2).path("id").asText());
    assertEquals(2, items().size());
    assertEquals(recordId, item(items(), "module-a").path("id").asText());

    JsonNode another = postJson(base + "/sops/save", body(json.createArrayNode().add(module("module-a", "开机并检查"))), 200);
    assertEquals(3, items().size());
    assertEquals(1, jdbc.queryForObject("select count(*) from work_items where workflow_id=?", Integer.class,
        UUID.fromString(another.path("id").asText())));
    ObjectNode retained = canonical.get(1).deepCopy();
    retained.remove("nextModuleIds");
    // This operation removes module-b; module-a still needs its instruction document.
    postJson(base + "/sops/save", edit(repeated,
        json.createArrayNode().add(retained).add(canonical.get(2))), 200);
    assertEquals(2, items().size());
    assertEquals(0, jdbc.queryForObject("select count(*) from work_items where workflow_id=? and module_id='module-b'", Integer.class, workflowId));
  }

  @Test
  void failedRevisionAndInvalidLayoutsCannotPartiallyChangeWorkRecordsOrWorkflow() throws Exception {
    ArrayNode steps = json.createArrayNode().add(module("first", "第一个模块")).add(module("second", "第二个模块"));
    JsonNode saved = postJson(base + "/sops/save", body(steps), 200);
    JsonNode before = items();
    ObjectNode stale = edit(saved, json.createArrayNode().add(module("third", "不应保存")))
        .put("expectedRevision", saved.path("revision").asLong() + 100);
    postJson(base + "/sops/save", stale, 409);

    List<ArrayNode> invalid = new ArrayList<>();
    for (Object value : List.of(-0.001, 0.801, "0.2")) {
      ObjectNode bad = module("bad", "非法位置");
      ObjectNode position = bad.putObject("position").put("y", 0.2);
      if (value instanceof Double d) position.put("x", d); else position.put("x", value.toString());
      invalid.add(json.createArrayNode().add(bad));
    }
    for (List<String> connections : List.of(List.of("first"), List.of("outside"), List.of("second", "second"))) {
      ObjectNode bad = module("first", "非法箭头");
      ArrayNode targets = bad.putArray("nextModuleIds");
      connections.forEach(targets::add);
      invalid.add(json.createArrayNode().add(bad).add(module("second", "第二个模块")));
    }
    invalid.add(json.createArrayNode().add(module("same", "工作一")).add(module("same", "工作二")));
    for (ArrayNode entries : invalid) {
      postJson(base + "/sops/save", edit(saved, entries), 400);
      postJson(base + "/sops/save", body(entries), 400);
    }
    assertEquals(before, items());
    assertEquals(1, request(get(base + "/sops"), 200).size());
    assertEquals(saved.path("draft"), request(get(base + "/sops"), 200).get(0).path("draft"));
  }

  @Test
  void resizedRectanglesKeepGeometryAndWorkRecordIdentityAcrossSaveAndReload() throws Exception {
    ObjectNode first = module("rectangle", "调整大小的工作");
    first.putObject("size").put("width", 0.62).put("height", 0.31);
    first.putObject("position").put("x", 0.38).put("y", 0.69);
    ObjectNode oldModule = module("old-default", "保留原来大小的工作");
    oldModule.putObject("position").put("x", 0.8).put("y", 0.8);
    ObjectNode sizeOnly = module("size-only", "暂未放置的工作");
    sizeOnly.putObject("size").put("width", 0.12).put("height", 1);
    ObjectNode instructions = detail("调整大小的工作");
    instructions.put("size", "详细做法中保留的无关扩展字段");
    instructions.putObject("position").put("x", -5).put("y", 7);
    ArrayNode steps = json.createArrayNode().add(first).add(oldModule).add(sizeOnly).add(instructions);
    JsonNode saved = postJson(base + "/sops/save", body(steps), 200);
    JsonNode originalRecords = items();
    assertEquals(3, originalRecords.size());
    assertEquals(steps, json.readTree(request(get(base + "/sops"), 200).get(0).path("draft").asText()));

    first.putObject("size").put("width", 0.8).put("height", 0.45);
    first.putObject("position").put("x", 0.2).put("y", 0.55);
    JsonNode resized = postJson(base + "/sops/save", edit(saved, steps), 200);
    assertEquals(originalRecords, items());
    assertEquals(steps, json.readTree(request(get(base + "/sops"), 200).get(0).path("draft").asText()));
    JsonNode history = request(get(base + "/sops/" + saved.path("id").asText() + "/versions"), 200);
    assertEquals(2, history.size());
    assertEquals(steps, json.readTree(history.get(0).path("steps").asText()));
    assertEquals(0.62, json.readTree(history.get(1).path("steps").asText())
        .get(0).path("size").path("width").asDouble());

    first.putObject("size").put("width", 1).put("height", 1);
    first.putObject("position").put("x", 0).put("y", 0);
    postJson(base + "/sops/save", edit(resized, steps), 200);
    assertEquals(originalRecords, items());
    assertEquals(steps, json.readTree(request(get(base + "/sops"), 200).get(0).path("draft").asText()));
  }

  @Test
  void invalidSizesAndPositionsCannotPartiallyChangeWorkflowRecordsOrPublishedHistory()
      throws Exception {
    JsonNode saved = postJson(base + "/sops/save",
        body(json.createArrayNode().add(module("work", "保留原有工作"))), 200);
    JsonNode originalRecords = items();
    List<JsonNode> invalidSizes = new ArrayList<>();
    for (double dimension : List.of(-0.1, 0.119, 1.001, Double.NaN, Double.POSITIVE_INFINITY)) {
      invalidSizes.add(json.createObjectNode().put("width", dimension).put("height", 0.2));
      invalidSizes.add(json.createObjectNode().put("width", 0.2).put("height", dimension));
    }
    invalidSizes.add(json.createObjectNode().put("width", "0.3").put("height", 0.2));
    invalidSizes.add(json.createObjectNode().put("width", 0.3).put("height", true));
    invalidSizes.add(json.createObjectNode().put("width", 0.3));
    invalidSizes.add(json.createArrayNode().add(0.3).add(0.2));
    invalidSizes.add(json.nullNode());
    List<ObjectNode> invalidModules = new ArrayList<>();
    for (JsonNode size : invalidSizes) {
      ObjectNode work = module("work", "不应保存的新名称");
      work.set("size", size);
      invalidModules.add(work);
    }
    for (double[] geometry : List.of(
        new double[] {0.6, 0.3, 0.4001, 0},
        new double[] {0.3, 0.8, 0, 0.2001},
        new double[] {1, 1, 0.001, 0},
        new double[] {0.12, 0.12, 0, -0.001})) {
      ObjectNode work = module("work", "不应保存的新名称");
      work.putObject("size").put("width", geometry[0]).put("height", geometry[1]);
      work.putObject("position").put("x", geometry[2]).put("y", geometry[3]);
      invalidModules.add(work);
    }
    for (ObjectNode work : invalidModules) {
      ArrayNode steps = json.createArrayNode().add(work);
      postJson(base + "/sops/save", edit(saved, steps), 400);
      postJson(base + "/sops/save", body(steps), 400);
    }
    assertEquals(originalRecords, items());
    JsonNode workflows = request(get(base + "/sops"), 200);
    assertEquals(1, workflows.size());
    assertEquals(saved, workflows.get(0));
    assertEquals(1, request(get(base + "/sops/" + saved.path("id").asText() + "/versions"), 200).size());
  }

  @Test
  void legacyBackfillDoesNotRewriteDraftOrVersionAndIsIdempotent() throws Exception {
    JsonNode saved = postJson(base + "/sops/save", body(json.createArrayNode().add(module("temporary", "临时模块"))), 200);
    UUID workflowId = UUID.fromString(saved.path("id").asText());
    String legacy = """
        [{"title":"旧版工作","description":"","custom":{"retain":true}},
         {"kind":"DETAIL","title":"独立做法","items":[{"text":"说明"}]},
         {"kind":"MODULE","title":"没有旧标识的模块"},
         {"id":"legacy-fixed","title":"有标识的旧版工作","description":"旧说明"}]
        """;
    jdbc.update("delete from work_items where workflow_id=?", workflowId);
    jdbc.update("update sops set draft=? where id=?", legacy, workflowId);
    JsonNode backfilled = items();
    assertEquals(3, backfilled.size());
    item(backfilled, "module-legacy-0");
    item(backfilled, "module-2");
    item(backfilled, "module-legacy-fixed");
    assertEquals(backfilled, items());
    assertEquals(legacy, jdbc.queryForObject("select draft from sops where id=?", String.class, workflowId));
    assertEquals(saved.path("revision").asLong(), jdbc.queryForObject("select revision from sops where id=?", Long.class, workflowId));
    assertEquals(1, request(get(base + "/sops/" + workflowId + "/versions"), 200).size());
  }

  @Test
  void draftEditPublishArchiveAndRepublishKeepRegistryInSync() throws Exception {
    JsonNode draft = postJson(base + "/sops", body(json.createArrayNode().add(module("a", "第一项"))), 200);
    String path = base + "/sops/" + draft.path("id").asText();
    JsonNode firstRecord = item(items(), "a");
    notes(firstRecord.path("id").asText(), "保留归档前记录", 200);
    request(put(path).content(json.writeValueAsString(body(json.createArrayNode().add(module("a", "改名")).add(module("b", "新增"))))), 200);
    postJson(path + "/publish", Map.of(), 200);
    assertEquals(2, items().size());
    assertEquals(firstRecord.path("id"), item(items(), "a").path("id"));
    postJson(path + "/archive", Map.of(), 200);
    assertEquals(0, items().size());
    notes(firstRecord.path("id").asText(), "不能修改已归档工作", 404);
    postJson(path + "/publish", Map.of(), 200);
    assertEquals("保留归档前记录", item(items(), "a").path("notes").asText());
  }

  @Test
  void listAndNotesRequireMembershipAndNotesRequireManagerWithCsrfAndSizeValidation() throws Exception {
    JsonNode saved = postJson(base + "/sops/save", body(json.createArrayNode().add(module("a", "工作"))), 200);
    String id = item(items(), "a").path("id").asText();
    String otherBase = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "其他手册"), 200).path("id").asText();
    request(put(otherBase + "/work-items/" + id).content("{\"notes\":\"不能跨手册修改\"}"), 404);
    notes(id, "x".repeat(20001), 400);
    request(put(base + "/work-items/" + id).content("{}"), 400);
    assertEquals(403, mvc.perform(put(base + "/work-items/" + id).session(session)
        .contentType("application/json").content("{\"notes\":\"缺少CSRF\"}")).andReturn().getResponse().getStatus());
    jdbc.update("update members set role='EMPLOYEE' where organization_id=? and user_id=?",
        UUID.fromString(saved.path("organizationId").asText()), userId);
    assertEquals(1, items().size());
    notes(id, "员工不能修改", 403);
    jdbc.update("update members set status='INACTIVE' where organization_id=? and user_id=?",
        UUID.fromString(saved.path("organizationId").asText()), userId);
    request(get(base + "/work-items"), 403);
    notes(id, "不是成员", 403);
    session = new MockHttpSession();
    request(get(base + "/work-items"), 401);
  }

  @Test
  void deletingBlankLegacyModulePreservesEmptyInstructionMetadataWithoutAcceptingBlankModernLists()
      throws Exception {
    ObjectNode legacy = json.createObjectNode().put("title", "原有空说明");
    legacy.put("imageUrl", "https://example.com/original.png");
    legacy.putObject("custom").put("keep", true);
    JsonNode saved = postJson(base + "/sops/save",
        body(json.createArrayNode().add(legacy).add(module("other", "另一项工作"))), 200);
    JsonNode original = item(items(), "module-legacy-0");
    ObjectNode preserved = legacy.deepCopy().put("kind", "DETAIL")
        .put("id", "detail-legacy-0").put("legacyEmpty", true);
    preserved.putArray("items");
    ArrayNode removed = json.createArrayNode().add(preserved).add(module("other", "另一项工作"));
    JsonNode changed = postJson(base + "/sops/save", edit(saved, removed), 200);
    assertEquals(removed, json.readTree(changed.path("draft").asText()));
    assertEquals(1, items().size());
    assertEquals(0, jdbc.queryForObject("select count(*) from work_items where id=?", Integer.class,
        UUID.fromString(original.path("id").asText())));
    preserved.put("description", " \n \u00A0\uFEFF");
    JsonNode blankDescription = postJson(base + "/sops/save", edit(changed, removed), 200);
    assertEquals(removed, json.readTree(blankDescription.path("draft").asText()));

    List<ObjectNode> invalid = new ArrayList<>();
    invalid.add(preserved.deepCopy().put("legacyEmpty", false));
    invalid.add(preserved.deepCopy().put("legacyEmpty", "true"));
    invalid.add(preserved.deepCopy().put("description", "非空原文不能用空列表替代"));
    ObjectNode blankItem = preserved.deepCopy();
    ((ArrayNode) blankItem.path("items")).addObject().put("text", " \n ");
    invalid.add(blankItem);
    ObjectNode unmarked = preserved.deepCopy();
    unmarked.remove("legacyEmpty");
    invalid.add(unmarked);
    for (ObjectNode detail : invalid)
      postJson(base + "/sops/save", edit(blankDescription,
          json.createArrayNode().add(detail).add(module("other", "另一项工作"))), 400);
    assertEquals(1, items().size());
  }
}
