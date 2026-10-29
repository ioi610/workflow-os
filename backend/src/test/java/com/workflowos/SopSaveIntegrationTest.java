package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:sop-save;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    })
@AutoConfigureMockMvc
class SopSaveIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  MockHttpSession session;
  String base;

  @BeforeEach
  void workspace() throws Exception {
    session = new MockHttpSession();
    register(UUID.randomUUID() + "@test.com");
    base =
        "/api/orgs/"
            + postJson("/api/organizations", Map.of("name", "流程手册测试"), 200).path("id").asText();
  }

  JsonNode request(MockHttpServletRequestBuilder builder, int expected) throws Exception {
    var response =
        mvc.perform(builder.session(session).with(csrf()).contentType("application/json"))
            .andReturn()
            .getResponse();
    assertEquals(expected, response.getStatus(), response.getContentAsString());
    return json.readTree(response.getContentAsString());
  }

  JsonNode postJson(String path, Object body, int expected) throws Exception {
    return request(post(path).content(json.writeValueAsString(body)), expected);
  }

  void register(String email) throws Exception {
    postJson(
        "/api/auth/register",
        Map.of("email", email, "password", "SecurePass123!", "displayName", "测试成员"),
        200);
  }

  JsonNode steps() throws Exception {
    return json.readTree(
        """
        [{"title":"清洁设备","description":"断电后拆卸并清洗。",
          "materials":["软布","清洁剂"],"notes":"完全晾干后重新组装。",
          "instructions":{"sequence":["断电","拆卸","清洗"],"temperature":40}}]
        """);
  }

  ObjectNode payload(String title, JsonNode steps) {
    ObjectNode body = json.createObjectNode();
    body.put("title", title);
    body.put("category", "清洁保养");
    body.set("steps", steps);
    return body;
  }

  ObjectNode edit(JsonNode sop, String title) throws Exception {
    ObjectNode body = payload(title, steps());
    body.put("id", sop.path("id").asText());
    body.put("expectedRevision", sop.path("revision").asLong());
    return body;
  }

  JsonNode saved() throws Exception {
    return postJson(base + "/sops/save", payload("设备清洁流程", steps()), 200);
  }

  JsonNode unfinishedInstructions() throws Exception {
    return json.readTree("""
        [{"kind":"MODULE","id":"work-clean","title":"清洁设备",
          "frame":{"x":40,"y":50,"width":164,"height":164}},
         {"kind":"DETAIL","id":"clean-instructions","title":"清洁设备",
          "items":[{"id":"written","text":"手动记录的第一步。","custom":{"keep":true}},
                   {"id":"blank","text":""},{"id":"spaces","text":" \\n "}],
          "materials":["软布","清洁剂"],"imageUrl":"https://example.com/reference.png",
          "custom":{"original":"完整保留"}},
         {"kind":"DETAIL","id":"unnamed-empty","title":"","items":[]},
         {"kind":"DETAIL","id":"unnamed-written","title":" \\t ",
          "items":[{"id":"note","text":"还没有起名字，但已经写下的内容。"}]}]
        """);
  }

  ObjectNode draftEdit(JsonNode saved, JsonNode content) {
    return payload(saved.path("title").asText(), content)
        .put("id", saved.path("id").asText())
        .put("expectedRevision", saved.path("revision").asLong())
        .put("draftOnly", true);
  }

  JsonNode versions(JsonNode sop) throws Exception {
    return request(get(base + "/sops/" + sop.path("id").asText() + "/versions"), 200);
  }

  JsonNode stored(JsonNode sop) throws Exception {
    for (JsonNode entry : request(get(base + "/sops"), 200))
      if (entry.path("id").equals(sop.path("id"))) return entry;
    fail("流程未保存");
    return null;
  }

  @Test
  void retryingCreationReturnsOneFlowWithoutChangingItsContentOrWorkRecords() throws Exception {
    String requestId = UUID.randomUUID().toString();
    ObjectNode creation = payload("文字生成的流程", unfinishedInstructions())
        .put("draftOnly", true).put("createRequestId", requestId);
    JsonNode first = postJson(base + "/sops/save", creation, 200);
    assertEquals(requestId, first.path("id").asText());
    JsonNode records = request(get(base + "/work-items"), 200);
    assertEquals(1, records.size());
    assertEquals(0, versions(first).size());
    assertEquals(first, postJson(base + "/sops/save", creation, 200));
    assertEquals(1, request(get(base + "/sops"), 200).size());
    assertEquals(records, request(get(base + "/work-items"), 200));

    JsonNode edited = postJson(base + "/sops/save",
        draftEdit(first, json.readTree(first.path("draft").asText())).put("title", "后来改过的流程"), 200);
    assertEquals(edited, postJson(base + "/sops/save", creation, 200));
    assertEquals(edited, stored(first));
    assertEquals(records, request(get(base + "/work-items"), 200));
    ObjectNode invalidEdit = draftEdit(edited, json.readTree(edited.path("draft").asText()))
        .put("createRequestId", requestId);
    postJson(base + "/sops/save", invalidEdit, 400);
    assertEquals(edited, stored(first));
  }

  @Test
  void creationReceiptsAreScopedToTheAuthorizedWorkspace() throws Exception {
    String requestId = UUID.randomUUID().toString();
    ObjectNode creation = payload("原工作区的流程", unfinishedInstructions())
        .put("draftOnly", true).put("createRequestId", requestId);
    JsonNode first = postJson(base + "/sops/save", creation, 200);
    String second = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "另一工作区"), 200)
        .path("id").asText();
    postJson(second + "/sops/save", creation, 409);
    assertEquals(0, request(get(second + "/sops"), 200).size());
    assertEquals(0, request(get(second + "/work-items"), 200).size());
    assertEquals(first, stored(first));

    session = new MockHttpSession();
    register(UUID.randomUUID() + "@test.com");
    postJson(base + "/sops/save", creation, 403);
  }

  @Test
  void savePublishesDetailedContentAndKeepsOldVersionsImmutable() throws Exception {
    JsonNode first = saved();
    assertEquals("PUBLISHED", first.path("status").asText());
    assertFalse(first.path("currentVersionId").isNull());
    assertEquals(first.path("revision"), stored(first).path("revision"));
    assertEquals(steps(), json.readTree(first.path("draft").asText()));
    JsonNode original = versions(first).get(0);
    assertEquals(first.path("currentVersionId"), original.path("id"));
    assertEquals(steps(), json.readTree(original.path("steps").asText()));

    ObjectNode changes = edit(first, "设备清洁与保养流程");
    ((ObjectNode) changes.path("steps").get(0)).put("notes", "先检查密封圈，再组装。");
    JsonNode updated = postJson(base + "/sops/save", changes, 200);
    assertTrue(updated.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(updated.path("revision"), stored(updated).path("revision"));
    JsonNode history = versions(updated);
    assertEquals(2, history.size());
    assertEquals(2, history.get(0).path("versionNumber").asInt());
    assertEquals(updated.path("currentVersionId"), history.get(0).path("id"));
    assertEquals(changes.path("steps"), json.readTree(history.get(0).path("steps").asText()));
    assertEquals(original, history.get(1));
  }

  @Test
  void staleAndMissingRevisionsCannotOverwriteSavedContent() throws Exception {
    JsonNode first = saved();
    JsonNode second = postJson(base + "/sops/save", edit(first, "同事保存的内容"), 200);
    postJson(base + "/sops/save", edit(first, "过期编辑"), 409);
    ObjectNode missingRevision = edit(second, "无版本编辑");
    missingRevision.remove("expectedRevision");
    postJson(base + "/sops/save", missingRevision, 400);
    assertEquals(second, stored(second));
    assertEquals(2, versions(second).size());
  }

  @Test
  void unchangedSavesDoNotCreateDuplicateVersions() throws Exception {
    JsonNode first = saved();
    JsonNode again = postJson(base + "/sops/save", edit(first, "设备清洁流程"), 200);
    assertEquals(first, again);
    assertEquals(1, versions(first).size());
  }

  @Test
  void draftOnlyKeepsAllUnfinishedInstructionsWithoutRepublishingOrChangingWorkIdentity()
      throws Exception {
    JsonNode partial = unfinishedInstructions();
    JsonNode first = postJson(base + "/sops/save", payload("步骤草稿流程",
        json.createArrayNode().add(partial.get(0))), 200);
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    String settings = json.writeValueAsString(boardSettings(true, true, 540, 1080));
    JsonNode draft = postJson(base + "/sops/save", draftEdit(first, partial)
        .put("boardSettings", settings), 200);
    assertEquals(partial, json.readTree(draft.path("draft").asText()));
    assertEquals(draft, stored(draft));
    assertTrue(draft.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(settings, draft.path("boardSettings").asText());
    assertEquals(first.path("status"), draft.path("status"));
    assertEquals(first.path("currentVersionId"), draft.path("currentVersionId"));
    assertEquals(history, versions(draft));
    assertEquals(records, request(get(base + "/work-items"), 200));
    assertEquals(draft, postJson(base + "/sops/save", draftEdit(draft, partial), 200));

    ObjectNode strict = draftEdit(draft, partial).put("draftOnly", false);
    postJson(base + "/sops/save", strict, 400);
    strict.remove("draftOnly");
    postJson(base + "/sops/save", strict, 400);
    postJson(base + "/sops/" + draft.path("id").asText() + "/publish", Map.of(), 400);
    assertEquals(draft, stored(draft));
    assertEquals(history, versions(draft));

    JsonNode complete = partial.deepCopy();
    ((ObjectNode) complete.get(1).path("items").get(1)).put("text", "第二步。");
    ((ObjectNode) complete.get(1).path("items").get(2)).put("text", "第三步。");
    ((ObjectNode) complete.get(2)).put("title", "准备材料").putArray("items")
        .addObject().put("id", "material-step").put("text", "准备好材料。");
    ((ObjectNode) complete.get(3)).put("title", "补充说明");
    JsonNode published = postJson(base + "/sops/save",
        draftEdit(draft, complete).put("draftOnly", false), 200);
    assertEquals(2, versions(published).size());
    assertNotEquals(first.path("currentVersionId"), published.path("currentVersionId"));
    assertEquals(complete, json.readTree(versions(published).get(0).path("steps").asText()));
    assertEquals(history.get(0), versions(published).get(1));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }

  @Test
  void draftOnlyRetainsStructureNamesMediaAndLayoutValidationAndRollsBackFailures()
      throws Exception {
    JsonNode partial = unfinishedInstructions();
    JsonNode first = postJson(base + "/sops/save", payload("草稿校验流程",
        json.createArrayNode().add(partial.get(0))), 200);
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    List<JsonNode> malformedDetails = new ArrayList<>();
    ObjectNode original = (ObjectNode) partial.get(1);
    ObjectNode noId = original.deepCopy();
    noId.remove("id");
    malformedDetails.add(noId);
    for (JsonNode id : List.of(json.nullNode(), json.getNodeFactory().numberNode(42),
        json.getNodeFactory().textNode(" \uFEFF "), json.getNodeFactory().textNode("x".repeat(256)))) {
      ObjectNode bad = original.deepCopy();
      bad.set("id", id);
      malformedDetails.add(bad);
    }
    ObjectNode noItems = original.deepCopy();
    noItems.remove("items");
    malformedDetails.add(noItems);
    for (JsonNode list : List.of(json.nullNode(), json.createObjectNode(),
        json.getNodeFactory().textNode("不是清单"), json.createArrayNode().addNull(),
        json.createArrayNode().add("不是步骤"),
        json.createArrayNode().add(json.createObjectNode().put("text", 42)))) {
      ObjectNode bad = original.deepCopy();
      bad.set("items", list);
      malformedDetails.add(bad);
    }
    ObjectNode tooManyItems = original.deepCopy();
    var items = tooManyItems.putArray("items");
    for (int index = 0; index < 101; index++) items.addObject().put("text", "");
    malformedDetails.add(tooManyItems);
    malformedDetails.add(original.deepCopy().putNull("title"));
    malformedDetails.add(original.deepCopy().put("imageUrl", "javascript:alert(1)"));
    List<JsonNode> invalid = new ArrayList<>();
    for (JsonNode bad : malformedDetails)
      invalid.add(json.createArrayNode().add(partial.get(0)).add(bad));
    invalid.add(json.createArrayNode().add(partial.get(0)).add(original)
        .add(original.deepCopy().put("title", "另一个名称")));
    invalid.add(json.createArrayNode().add(partial.get(0)).add(original)
        .add(original.deepCopy().put("id", "another").put("title", " 清洁设备 ")));
    var tooManyDetails = json.createArrayNode().add(partial.get(0));
    for (int index = 0; index < 101; index++)
      tooManyDetails.addObject().put("kind", "DETAIL").put("id", "blank-" + index)
          .put("title", "").putArray("items");
    invalid.add(tooManyDetails);
    ObjectNode badModule = ((ObjectNode) partial.get(0)).deepCopy().put("title", "");
    invalid.add(json.createArrayNode().add(badModule).add(original));
    ObjectNode outside = ((ObjectNode) partial.get(0)).deepCopy();
    ((ObjectNode) outside.path("frame")).put("x", 800);
    invalid.add(json.createArrayNode().add(outside).add(original));
    for (JsonNode invalidSteps : invalid)
      postJson(base + "/sops/save", draftEdit(first, invalidSteps).put("title", "不应保存"), 400);
    // Creation without draftOnly remains strict, even if all IDs are valid.
    postJson(base + "/sops/save", payload("不应创建的发布流程", partial), 400);
    assertEquals(first, stored(first));
    assertEquals(history, versions(first));
    assertEquals(records, request(get(base + "/work-items"), 200));
    assertEquals(1, request(get(base + "/sops"), 200).size());
  }

  @Test
  void draftOnlyCannotBypassRevisionOrganizationOrEmployeeRestrictions() throws Exception {
    JsonNode first = saved();
    JsonNode partial = unfinishedInstructions();
    JsonNode draft = postJson(base + "/sops/save", draftEdit(first, partial), 200);
    postJson(base + "/sops/save", draftEdit(first, partial).put("title", "过期草稿"), 409);
    ObjectNode missingRevision = draftEdit(draft, partial);
    missingRevision.remove("expectedRevision");
    postJson(base + "/sops/save", missingRevision, 400);
    String otherBase = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "其他工作区"), 200)
        .path("id").asText();
    postJson(otherBase + "/sops/save", draftEdit(draft, partial), 404);
    String employeeEmail = UUID.randomUUID() + "@test.com";
    JsonNode invitation = postJson(base + "/invitations",
        Map.of("email", employeeEmail, "role", "EMPLOYEE"), 200);
    MockHttpSession owner = session;
    session = new MockHttpSession();
    register(employeeEmail);
    postJson(base + "/invitations/accept", Map.of("token", invitation.path("token").asText()), 200);
    postJson(base + "/sops/save", draftEdit(draft, partial), 403);
    session = owner;
    assertEquals(draft, stored(draft));
    assertEquals(1, versions(draft).size());
  }

  @Test
  void emptyTemplatesCanBeSavedFilledAndClearedWithRevisionProtection() throws Exception {
    var empty = json.createArrayNode();
    JsonNode first = postJson(base + "/sops/save", payload("空白工作模板", empty), 200);
    assertEquals(first, stored(first));
    assertEquals(empty, json.readTree(stored(first).path("draft").asText()));
    assertEquals(empty, json.readTree(versions(first).get(0).path("steps").asText()));

    ObjectNode unchanged = payload("空白工作模板", empty);
    unchanged.put("id", first.path("id").asText());
    unchanged.put("expectedRevision", first.path("revision").asLong());
    assertEquals(first, postJson(base + "/sops/save", unchanged, 200));
    assertEquals(1, versions(first).size());

    JsonNode modules =
        json.readTree("[{\"kind\":\"MODULE\",\"id\":\"module-preparation\",\"title\":\"准备材料\"}]");
    ObjectNode append = unchanged.deepCopy();
    append.set("steps", modules);
    JsonNode filled = postJson(base + "/sops/save", append, 200);
    assertTrue(filled.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(modules, json.readTree(stored(filled).path("draft").asText()));
    assertEquals(2, versions(filled).size());
    assertEquals(empty, json.readTree(versions(filled).get(1).path("steps").asText()));
    postJson(base + "/sops/save", unchanged, 409);
    assertEquals(filled, stored(filled));

    ObjectNode clear = unchanged.deepCopy();
    clear.put("expectedRevision", filled.path("revision").asLong());
    JsonNode cleared = postJson(base + "/sops/save", clear, 200);
    assertTrue(cleared.path("revision").asLong() > filled.path("revision").asLong());
    assertEquals(empty, json.readTree(stored(cleared).path("draft").asText()));
    assertEquals(3, versions(cleared).size());
    assertEquals(modules, json.readTree(versions(cleared).get(1).path("steps").asText()));
  }

  @Test
  void invalidContentLeavesSopAndPublishedHistoryUnchanged() throws Exception {
    postJson(base + "/sops/save", payload("无步骤数组", json.nullNode()), 400);
    assertEquals(0, request(get(base + "/sops"), 200).size());
    JsonNode first = saved();
    ObjectNode invalid = edit(first, "不应保存的名称");
    invalid.set("steps", json.readTree("[{\"title\":\"\"}]"));
    postJson(base + "/sops/save", invalid, 400);
    invalid.set("steps", json.readTree("[{\"title\":\"清洁\",\"imageUrl\":\"javascript:bad\"}]"));
    postJson(base + "/sops/save", invalid, 400);
    assertEquals(first, stored(first));
    assertEquals(1, versions(first).size());
  }

  @Test
  void employeesCanReadButOnlyManagersAndOwnersCanSave() throws Exception {
    JsonNode first = saved();
    MockHttpSession owner = session;
    String employeeEmail = UUID.randomUUID() + "@test.com";
    String managerEmail = UUID.randomUUID() + "@test.com";
    JsonNode employeeInvitation =
        postJson(base + "/invitations", Map.of("email", employeeEmail, "role", "EMPLOYEE"), 200);
    JsonNode managerInvitation =
        postJson(base + "/invitations", Map.of("email", managerEmail, "role", "MANAGER"), 200);
    session = new MockHttpSession();
    register(employeeEmail);
    postJson(
        base + "/invitations/accept",
        Map.of("token", employeeInvitation.path("token").asText()),
        200);
    assertEquals(1, versions(first).size());
    postJson(base + "/sops/save", edit(first, "员工尝试修改"), 403);
    postJson(base + "/sops/save", payload("员工尝试新增", steps()), 403);
    session = new MockHttpSession();
    register(managerEmail);
    postJson(
        base + "/invitations/accept",
        Map.of("token", managerInvitation.path("token").asText()),
        200);
    JsonNode updated = postJson(base + "/sops/save", edit(first, "管理员修改"), 200);
    session = owner;
    assertEquals(updated, stored(first));
  }

  @Test
  void savedSopsCannotBeEditedThroughAnotherWorkspace() throws Exception {
    JsonNode first = saved();
    String otherBase =
        "/api/orgs/"
            + postJson("/api/organizations", Map.of("name", "另一组织"), 200).path("id").asText();
    postJson(otherBase + "/sops/save", edit(first, "跨组织修改"), 404);
    assertEquals(first, stored(first));
  }

  ObjectNode boardSettings(boolean timelineEnabled, boolean priorityEnabled, int start, int end) {
    ObjectNode settings = json.createObjectNode().put("version", 1);
    settings.putObject("timeline").put("enabled", timelineEnabled)
        .put("startMinute", start).put("endMinute", end);
    settings.putObject("priority").put("enabled", priorityEnabled);
    return settings;
  }

  ObjectNode timeSegment(int start, int end, double scale) {
    return json.createObjectNode().put("startOffset", start).put("endOffset", end).put("scale", scale);
  }

  @Test
  void boardSettingsSaveIndependentlyKeepWorkIdentityAndSnapshotHistoryWithSemanticDeduplication()
      throws Exception {
    JsonNode first = saved();
    assertTrue(first.path("boardSettings").isNull());
    JsonNode originalHistory = versions(first).get(0);
    JsonNode originalRecords = request(get(base + "/work-items"), 200);
    ObjectNode settings = boardSettings(true, true, 540, 1080);
    settings.putObject("custom").put("keep", "保留额外设置");
    ((ObjectNode) settings.path("timeline")).put("customLabel", "原有标签");
    JsonNode configured = postJson(base + "/sops/save", edit(first, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);

    assertTrue(configured.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(settings, json.readTree(configured.path("boardSettings").asText()));
    assertEquals(configured, stored(first));
    assertEquals(first.path("draft"), configured.path("draft"));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
    JsonNode history = versions(configured);
    assertEquals(2, history.size());
    assertEquals(settings, json.readTree(history.get(0).path("boardSettings").asText()));
    assertEquals(originalHistory, history.get(1));

    String reordered = """
        {"custom":{"keep":"保留额外设置"},
         "priority":{"enabled":true},
         "timeline":{"customLabel":"原有标签","endMinute":1080,"startMinute":540,"enabled":true},
         "version":1}
        """;
    assertEquals(configured, postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", reordered), 200));
    assertEquals(2, versions(configured).size());

    ObjectNode disabled = boardSettings(false, false, 1380, 60);
    JsonNode hidden = postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(disabled)), 200);
    assertEquals(disabled, json.readTree(hidden.path("boardSettings").asText()));
    assertEquals(3, versions(hidden).size());
    assertEquals(settings, json.readTree(versions(hidden).get(1).path("boardSettings").asText()));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
  }

  @Test
  void omittedAndNullSettingsFromOlderClientsPreserveConfigurationIncludingDraftPublish()
      throws Exception {
    ObjectNode settings = boardSettings(true, false, 0, 1439);
    JsonNode configured = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertEquals(configured, postJson(base + "/sops/save", edit(configured, "设备清洁流程"), 200));
    ObjectNode explicitNull = edit(configured, "设备清洁流程");
    explicitNull.putNull("boardSettings");
    assertEquals(configured, postJson(base + "/sops/save", explicitNull, 200));
    assertEquals(1, versions(configured).size());

    JsonNode renamed = postJson(base + "/sops/save", edit(configured, "旧客户端修改名称"), 200);
    assertEquals(configured.path("boardSettings"), renamed.path("boardSettings"));
    assertEquals(configured.path("boardSettings"), versions(renamed).get(0).path("boardSettings"));

    request(put(base + "/sops/" + renamed.path("id").asText())
        .content(json.writeValueAsString(payload("旧方式修改草稿", steps()))), 200);
    postJson(base + "/sops/" + renamed.path("id").asText() + "/publish", Map.of(), 200);
    assertEquals(configured.path("boardSettings"), stored(renamed).path("boardSettings"));
    assertEquals(configured.path("boardSettings"), versions(renamed).get(0).path("boardSettings"));
  }

  @Test
  void focusedTimeRangesRoundTripDeduplicateAndSnapshotWithoutChangingWorkIdentity()
      throws Exception {
    JsonNode first = saved();
    JsonNode originalRecords = request(get(base + "/work-items"), 200);
    JsonNode firstHistory = versions(first).get(0);
    ObjectNode settings = boardSettings(true, true, 1380, 60);
    ObjectNode timeline = (ObjectNode) settings.path("timeline");
    timeline.put("axis", "y");
    ((ObjectNode) settings.path("priority")).put("axis", "x");
    timeline.putObject("focus").put("startOffset", 30).put("endOffset", 90)
        .put("scale", 4.5).put("custom", "保留额外内容");
    JsonNode focused = postJson(base + "/sops/save", edit(first, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertEquals(settings, json.readTree(stored(focused).path("boardSettings").asText()));
    assertTrue(focused.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(first.path("draft"), focused.path("draft"));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
    assertEquals(settings, json.readTree(versions(focused).get(0).path("boardSettings").asText()));
    assertEquals(firstHistory, versions(focused).get(1));

    ObjectNode reordered = settings.deepCopy();
    ((ObjectNode) reordered.path("timeline")).putObject("focus")
        .put("custom", "保留额外内容").put("scale", 4.5)
        .put("endOffset", 90).put("startOffset", 30);
    assertEquals(focused, postJson(base + "/sops/save", edit(focused, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(reordered)), 200));
    assertEquals(2, versions(focused).size());

    timeline.putObject("focus").put("startOffset", 0).put("endOffset", 120).put("scale", 10);
    JsonNode fullRange = postJson(base + "/sops/save", edit(focused, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertEquals(settings, json.readTree(fullRange.path("boardSettings").asText()));
    assertEquals(3, versions(fullRange).size());
    assertEquals(json.readTree(focused.path("boardSettings").asText()),
        json.readTree(versions(fullRange).get(1).path("boardSettings").asText()));
    timeline.putNull("focus");
    JsonNode reset = postJson(base + "/sops/save", edit(fullRange, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertEquals(settings, json.readTree(reset.path("boardSettings").asText()));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
    assertEquals(4, versions(reset).size());
  }

  @Test
  void olderTimelineEditsKeepFocusOnlyWhileTheirRangeAndEffectiveDirectionStayTheSame()
      throws Exception {
    ObjectNode settings = boardSettings(true, true, 540, 1080);
    settings.putObject("canvas").put("width", 1300).put("height", 800);
    settings.putObject("referenceCanvas").put("width", 820).put("height", 820);
    ((ObjectNode) settings.path("timeline")).putObject("focus")
        .put("startOffset", 120).put("endOffset", 240).put("scale", 3);
    JsonNode focused = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    JsonNode records = request(get(base + "/work-items"), 200);
    ObjectNode oldClient = boardSettings(true, true, 540, 1080);
    assertEquals(focused, postJson(base + "/sops/save", edit(focused, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200));
    assertEquals(focused, postJson(base + "/sops/save", edit(focused, "设备清洁流程"), 200));
    assertEquals(focused, postJson(base + "/sops/save", edit(focused, "设备清洁流程")
        .putNull("boardSettings"), 200));
    assertEquals(1, versions(focused).size());

    ((ObjectNode) oldClient.path("priority")).put("axis", "y");
    JsonNode sameDirection = postJson(base + "/sops/save", edit(focused, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200);
    JsonNode kept = json.readTree(sameDirection.path("boardSettings").asText());
    assertEquals(settings.path("timeline").path("focus"), kept.path("timeline").path("focus"));
    assertEquals(settings.path("canvas"), kept.path("canvas"));
    assertEquals(settings.path("referenceCanvas"), kept.path("referenceCanvas"));

    ((ObjectNode) oldClient.path("timeline")).put("endMinute", 960);
    JsonNode changedRange = postJson(base + "/sops/save", edit(sameDirection, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200);
    assertTrue(json.readTree(changedRange.path("boardSettings").asText())
        .path("timeline").path("focus").isNull());

    ObjectNode restored = oldClient.deepCopy();
    ((ObjectNode) restored.path("timeline")).putObject("focus")
        .put("startOffset", 0).put("endOffset", 420).put("scale", 1);
    JsonNode refocused = postJson(base + "/sops/save", edit(changedRange, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(restored)), 200);
    // A missing timeline.axis is inferred from priority.axis; changing that inferred direction resets focus.
    ((ObjectNode) oldClient.path("priority")).put("axis", "x");
    JsonNode changedDirection = postJson(base + "/sops/save", edit(refocused, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200);
    JsonNode reset = json.readTree(changedDirection.path("boardSettings").asText());
    assertTrue(reset.path("timeline").path("focus").isNull());
    assertEquals(settings.path("canvas"), reset.path("canvas"));
    assertEquals(settings.path("referenceCanvas"), reset.path("referenceCanvas"));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }

  @Test
  void invalidTimeFocusCannotPartiallySaveContentHistoryOrWorkRecords() throws Exception {
    ObjectNode valid = boardSettings(true, true, 540, 1080);
    ObjectNode focus = ((ObjectNode) valid.path("timeline")).putObject("focus")
        .put("startOffset", 60).put("endOffset", 120).put("scale", 2);
    JsonNode first = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(valid)), 200);
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    List<JsonNode> invalid = new ArrayList<>(List.of(json.createArrayNode(),
        json.getNodeFactory().textNode("60-120"), json.getNodeFactory().booleanNode(true),
        json.createObjectNode()));
    for (String key : List.of("startOffset", "endOffset", "scale")) {
      ObjectNode missing = focus.deepCopy();
      missing.remove(key);
      invalid.add(missing);
      for (JsonNode value : List.of(json.nullNode(), json.getNodeFactory().textNode("2"),
          json.getNodeFactory().booleanNode(true))) {
        ObjectNode malformed = focus.deepCopy();
        malformed.set(key, value);
        invalid.add(malformed);
      }
    }
    for (int start : List.of(-1, 120, 121)) invalid.add(focus.deepCopy().put("startOffset", start));
    invalid.add(focus.deepCopy().put("startOffset", 60.5));
    invalid.add(focus.deepCopy().put("endOffset", 541));
    invalid.add(focus.deepCopy().put("endOffset", 120.5));
    invalid.add(focus.deepCopy().put("endOffset", 2147483648L));
    invalid.add(focus.deepCopy().put("scale", 0.99));
    invalid.add(focus.deepCopy().put("scale", 10.01));
    List<String> invalidSettings = new ArrayList<>();
    for (JsonNode invalidFocus : invalid) {
      ObjectNode settings = valid.deepCopy();
      ((ObjectNode) settings.path("timeline")).set("focus", invalidFocus);
      invalidSettings.add(json.writeValueAsString(settings));
    }
    invalidSettings.add(json.writeValueAsString(valid).replace("\"scale\":2", "\"scale\":1e309"));
    for (String encoded : invalidSettings) {
      ObjectNode changed = edit(first, "不应保存的名称").put("boardSettings", encoded);
      ((ObjectNode) changed.path("steps").get(0)).put("description", "不应保存的内容");
      postJson(base + "/sops/save", changed, 400);
    }
    postJson(base + "/sops/save", payload("不应创建的流程", steps())
        .put("boardSettings", invalidSettings.get(0)), 400);
    assertEquals(first, stored(first));
    assertEquals(history, versions(first));
    assertEquals(records, request(get(base + "/work-items"), 200));
    assertEquals(1, request(get(base + "/sops"), 200).size());
  }

  @Test
  void multipleTimeSegmentsRoundTripSnapshotAndDeduplicateWithoutChangingWorkIdentity()
      throws Exception {
    JsonNode first = saved();
    JsonNode records = request(get(base + "/work-items"), 200);
    JsonNode originalVersion = versions(first).get(0);
    ObjectNode settings = boardSettings(true, true, 1320, 180);
    settings.putObject("canvas").put("width", 1400).put("height", 1000);
    settings.putObject("referenceCanvas").put("width", 820).put("height", 820);
    ObjectNode timeline = (ObjectNode) settings.path("timeline");
    // Legacy focus remains valid stored data; explicit segments (including empty/null) take precedence.
    timeline.putObject("focus").put("startOffset", 30).put("endOffset", 60).put("scale", 2);
    var segments = timeline.putArray("segments");
    segments.add(timeSegment(0, 30, 1e-6).put("custom", "保留额外内容"));
    segments.add(timeSegment(30, 60, 10000));
    segments.add(timeSegment(90, 150, 0.5));
    segments.add(timeSegment(150, 300, 2));
    JsonNode configured = postJson(base + "/sops/save", edit(first, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertEquals(settings, json.readTree(stored(configured).path("boardSettings").asText()));
    assertEquals(first.path("draft"), configured.path("draft"));
    assertTrue(configured.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(settings, json.readTree(versions(configured).get(0).path("boardSettings").asText()));
    assertEquals(originalVersion, versions(configured).get(1));
    assertEquals(records, request(get(base + "/work-items"), 200));

    ObjectNode reordered = settings.deepCopy();
    ((ObjectNode) reordered.path("timeline")).putArray("segments")
        .add(json.createObjectNode().put("custom", "保留额外内容").put("scale", 1e-6)
            .put("endOffset", 30).put("startOffset", 0))
        .add(timeSegment(30, 60, 10000)).add(timeSegment(90, 150, 0.5))
        .add(timeSegment(150, 300, 2));
    assertEquals(configured, postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(reordered)), 200));
    assertEquals(2, versions(configured).size());

    var maximumSegments = timeline.putArray("segments");
    for (int index = 0; index < 96; index++)
      maximumSegments.add(timeSegment(index * 3, (index + 1) * 3, index % 2 == 0 ? 0.5 : 2));
    JsonNode maximum = postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertEquals(96, json.readTree(maximum.path("boardSettings").asText())
        .path("timeline").path("segments").size());
    timeline.putArray("segments");
    JsonNode cleared = postJson(base + "/sops/save", edit(maximum, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertTrue(json.readTree(cleared.path("boardSettings").asText())
        .path("timeline").path("segments").isEmpty());
    timeline.putNull("segments");
    JsonNode reset = postJson(base + "/sops/save", edit(cleared, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    assertEquals(settings, json.readTree(reset.path("boardSettings").asText()));
    assertEquals(5, versions(reset).size());
    assertEquals(json.readTree(configured.path("boardSettings").asText()),
        json.readTree(versions(reset).get(3).path("boardSettings").asText()));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }

  @Test
  void olderClientsKeepSegmentsDespiteFocusEditsUntilTimelineRangeOrDirectionChanges()
      throws Exception {
    ObjectNode settings = boardSettings(true, true, 1380, 60);
    settings.putObject("canvas").put("width", 1300).put("height", 800);
    settings.putObject("referenceCanvas").put("width", 820).put("height", 820);
    ObjectNode timeline = (ObjectNode) settings.path("timeline");
    timeline.putNull("focus");
    timeline.putArray("segments").add(timeSegment(0, 30, 0.25)).add(timeSegment(60, 120, 4));
    JsonNode configured = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(settings)), 200);
    JsonNode records = request(get(base + "/work-items"), 200);
    ObjectNode oldClient = boardSettings(true, true, 1380, 60);
    assertEquals(configured, postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200));
    assertEquals(configured, postJson(base + "/sops/save", edit(configured, "设备清洁流程"), 200));
    assertEquals(configured, postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .putNull("boardSettings"), 200));
    ((ObjectNode) oldClient.path("timeline")).putObject("focus")
        .put("startOffset", 30).put("endOffset", 60).put("scale", 3);
    ((ObjectNode) oldClient.path("priority")).put("axis", "y");
    JsonNode focusEdited = postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200);
    assertEquals(timeline.path("segments"), json.readTree(focusEdited.path("boardSettings").asText())
        .path("timeline").path("segments"));

    ((ObjectNode) oldClient.path("timeline")).put("endMinute", 30);
    JsonNode rangeChanged = postJson(base + "/sops/save", edit(focusEdited, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200);
    assertTrue(json.readTree(rangeChanged.path("boardSettings").asText())
        .path("timeline").path("segments").isNull());
    ObjectNode restored = oldClient.deepCopy();
    ((ObjectNode) restored.path("timeline")).putArray("segments").add(timeSegment(0, 90, 0.5));
    JsonNode segmentedAgain = postJson(base + "/sops/save", edit(rangeChanged, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(restored)), 200);
    ((ObjectNode) oldClient.path("priority")).put("axis", "x");
    JsonNode directionChanged = postJson(base + "/sops/save", edit(segmentedAgain, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(oldClient)), 200);
    JsonNode reset = json.readTree(directionChanged.path("boardSettings").asText());
    assertTrue(reset.path("timeline").path("segments").isNull());
    assertEquals(settings.path("canvas"), reset.path("canvas"));
    assertEquals(settings.path("referenceCanvas"), reset.path("referenceCanvas"));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }

  @Test
  void invalidOrOverlappingTimeSegmentsRollBackTheWholeWorkflowSave() throws Exception {
    ObjectNode valid = boardSettings(true, true, 1380, 60);
    ((ObjectNode) valid.path("timeline")).putNull("focus");
    ((ObjectNode) valid.path("timeline")).putArray("segments").add(timeSegment(0, 120, 2));
    JsonNode first = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(valid)), 200);
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    List<JsonNode> invalid = new ArrayList<>(List.of(json.createObjectNode(),
        json.getNodeFactory().textNode("0-120"), json.getNodeFactory().booleanNode(true),
        json.createArrayNode().addNull(), json.createArrayNode().add(json.createObjectNode())));
    for (String key : List.of("startOffset", "endOffset", "scale")) {
      ObjectNode missing = timeSegment(0, 120, 2);
      missing.remove(key);
      invalid.add(json.createArrayNode().add(missing));
      for (JsonNode value : List.of(json.nullNode(), json.getNodeFactory().textNode("2"),
          json.getNodeFactory().booleanNode(true))) {
        ObjectNode malformed = timeSegment(0, 120, 2);
        malformed.set(key, value);
        invalid.add(json.createArrayNode().add(malformed));
      }
    }
    for (ObjectNode malformed : List.of(timeSegment(-1, 30, 2), timeSegment(30, 30, 2),
        timeSegment(31, 30, 2), timeSegment(0, 121, 2),
        timeSegment(0, 120, 0), timeSegment(0, 120, -1),
        timeSegment(0, 120, 0.0000009), timeSegment(0, 120, 10000.01),
        timeSegment(0, 120, 2).put("startOffset", 0.5),
        timeSegment(0, 120, 2).put("endOffset", 120.5),
        timeSegment(0, 120, 2).put("endOffset", 2147483648L)))
      invalid.add(json.createArrayNode().add(malformed));
    invalid.add(json.createArrayNode().add(timeSegment(0, 61, 2)).add(timeSegment(60, 90, 2)));
    invalid.add(json.createArrayNode().add(timeSegment(60, 90, 2)).add(timeSegment(0, 30, 2)));
    invalid.add(json.createArrayNode().add(timeSegment(0, 30, 2)).add(timeSegment(0, 30, 2)));
    var tooMany = json.createArrayNode();
    for (int index = 0; index < 97; index++) tooMany.add(timeSegment(index, index + 1, 1));
    invalid.add(tooMany);
    List<String> invalidSettings = new ArrayList<>();
    for (JsonNode invalidSegments : invalid) {
      ObjectNode settings = valid.deepCopy();
      ((ObjectNode) settings.path("timeline")).set("segments", invalidSegments);
      invalidSettings.add(json.writeValueAsString(settings));
    }
    invalidSettings.add(json.writeValueAsString(valid).replace("\"scale\":2.0", "\"scale\":1e309"));
    for (String encoded : invalidSettings) {
      ObjectNode changed = edit(first, "不应保存的名称").put("boardSettings", encoded);
      ((ObjectNode) changed.path("steps").get(0)).put("description", "不应保存的内容");
      postJson(base + "/sops/save", changed, 400);
    }
    postJson(base + "/sops/save", payload("不应创建的流程", steps())
        .put("boardSettings", invalidSettings.get(0)), 400);
    // Valid timeline settings and canvas changes must still fail atomically if a frame no longer fits.
    ObjectNode smaller = valid.deepCopy();
    smaller.putObject("canvas").put("width", 320).put("height", 320);
    ((ObjectNode) smaller.path("timeline")).putArray("segments").add(timeSegment(0, 120, 3));
    ObjectNode invalidFrame = edit(first, "边界外的工作不应保存")
        .put("boardSettings", json.writeValueAsString(smaller));
    ((ObjectNode) invalidFrame.path("steps").get(0)).putObject("frame")
        .put("x", 300).put("y", 0).put("width", 64).put("height", 64);
    postJson(base + "/sops/save", invalidFrame, 400);
    assertEquals(first, stored(first));
    assertEquals(history, versions(first));
    assertEquals(records, request(get(base + "/work-items"), 200));
    assertEquals(1, request(get(base + "/sops"), 200).size());
  }

  @Test
  void malformedBoardSettingsCannotPartiallyChangeWorkflowsRecordsOrPublishedHistory()
      throws Exception {
    JsonNode first = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(boardSettings(true, true, 1380, 60))), 200);
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    List<String> invalid = new ArrayList<>(List.of("", "{broken", "null", "[]", "{}"));
    invalid.add(json.writeValueAsString(boardSettings(false, false, 540, 1080)) + " ".repeat(8192));
    for (JsonNode version : List.of(json.getNodeFactory().numberNode(2), json.getNodeFactory().numberNode(1.0), json.getNodeFactory().textNode("1"))) {
      ObjectNode settings = boardSettings(true, true, 540, 1080);
      settings.set("version", version);
      invalid.add(json.writeValueAsString(settings));
    }
    for (String section : List.of("timeline", "priority")) {
      ObjectNode missing = boardSettings(true, true, 540, 1080);
      missing.remove(section);
      invalid.add(json.writeValueAsString(missing));
      ObjectNode nonBoolean = boardSettings(true, true, 540, 1080);
      ((ObjectNode) nonBoolean.path(section)).put("enabled", "true");
      invalid.add(json.writeValueAsString(nonBoolean));
    }
    for (String key : List.of("startMinute", "endMinute")) {
      for (JsonNode value : List.of(json.getNodeFactory().numberNode(-1), json.getNodeFactory().numberNode(1440),
          json.getNodeFactory().numberNode(540.5), json.getNodeFactory().textNode("540"), json.nullNode())) {
        ObjectNode settings = boardSettings(false, false, 540, 1080);
        ((ObjectNode) settings.path("timeline")).set(key, value);
        invalid.add(json.writeValueAsString(settings));
      }
    }
    invalid.add(json.writeValueAsString(boardSettings(false, false, 540, 540)));
    for (String settings : invalid) {
      postJson(base + "/sops/save", edit(first, "不应保存的名称").put("boardSettings", settings), 400);
      postJson(base + "/sops/save", payload("不应创建的流程", steps()).put("boardSettings", settings), 400);
    }
    assertEquals(first, stored(first));
    assertEquals(1, request(get(base + "/sops"), 200).size());
    assertEquals(history, versions(first));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }

  @Test
  void boardSettingsCannotBypassRevisionWorkspaceOrEmployeeRestrictions() throws Exception {
    JsonNode first = saved();
    String initialSettings = json.writeValueAsString(boardSettings(true, false, 540, 1080));
    JsonNode configured = postJson(base + "/sops/save", edit(first, "设备清洁流程")
        .put("boardSettings", initialSettings), 200);
    String changedSettings = json.writeValueAsString(boardSettings(false, true, 540, 1080));
    postJson(base + "/sops/save", edit(first, "设备清洁流程").put("boardSettings", changedSettings), 409);
    String otherBase = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "其他工作区"), 200)
        .path("id").asText();
    postJson(otherBase + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", changedSettings), 404);
    String employeeEmail = UUID.randomUUID() + "@test.com";
    JsonNode invitation = postJson(base + "/invitations",
        Map.of("email", employeeEmail, "role", "EMPLOYEE"), 200);
    MockHttpSession owner = session;
    session = new MockHttpSession();
    register(employeeEmail);
    postJson(base + "/invitations/accept", Map.of("token", invitation.path("token").asText()), 200);
    postJson(base + "/sops/save", edit(configured, "设备清洁流程")
        .put("boardSettings", changedSettings), 403);
    session = owner;
    assertEquals(configured, stored(first));
    assertEquals(2, versions(first).size());
  }

  @Test
  void axisDirectionsPreserveOldDefaultsAllowPartialConfigurationAndSnapshotWithoutRewritingWork()
      throws Exception {
    ObjectNode originalSettings = boardSettings(true, true, 1380, 60);
    JsonNode current = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(originalSettings)), 200);
    JsonNode firstHistory = versions(current).get(0);
    JsonNode originalRecords = request(get(base + "/work-items"), 200);
    assertFalse(json.readTree(current.path("boardSettings").asText()).path("timeline").has("axis"));
    assertFalse(json.readTree(current.path("boardSettings").asText()).path("priority").has("axis"));

    List<ObjectNode> configurations = new ArrayList<>();
    ObjectNode onlyTimeline = originalSettings.deepCopy();
    ((ObjectNode) onlyTimeline.path("timeline")).put("axis", "y");
    configurations.add(onlyTimeline);
    ObjectNode onlyPriority = originalSettings.deepCopy();
    ((ObjectNode) onlyPriority.path("priority")).put("axis", "x");
    configurations.add(onlyPriority);
    ObjectNode swapped = originalSettings.deepCopy();
    ((ObjectNode) swapped.path("timeline")).put("axis", "y");
    ((ObjectNode) swapped.path("priority")).put("axis", "x");
    swapped.putObject("custom").put("keep", "额外内容");
    configurations.add(swapped);
    ObjectNode hiddenPriority = boardSettings(true, false, 540, 1080);
    ((ObjectNode) hiddenPriority.path("timeline")).put("axis", "x");
    ((ObjectNode) hiddenPriority.path("priority")).put("axis", "x");
    configurations.add(hiddenPriority);
    ObjectNode hiddenTimeline = boardSettings(false, true, 540, 1080);
    ((ObjectNode) hiddenTimeline.path("timeline")).put("axis", "y");
    ((ObjectNode) hiddenTimeline.path("priority")).put("axis", "y");
    configurations.add(hiddenTimeline);
    for (ObjectNode settings : configurations) {
      JsonNode changed = postJson(base + "/sops/save", edit(current, "设备清洁流程")
          .put("boardSettings", json.writeValueAsString(settings)), 200);
      assertTrue(changed.path("revision").asLong() > current.path("revision").asLong());
      assertEquals(settings, json.readTree(changed.path("boardSettings").asText()));
      assertEquals(changed, stored(changed));
      assertEquals(current.path("draft"), changed.path("draft"));
      assertEquals(originalRecords, request(get(base + "/work-items"), 200));
      current = changed;
    }
    JsonNode history = versions(current);
    assertEquals(configurations.size() + 1, history.size());
    assertEquals(firstHistory, history.get(configurations.size()));
    for (int i = 0; i < configurations.size(); i++)
      assertEquals(configurations.get(i), json.readTree(
          history.get(configurations.size() - 1 - i).path("boardSettings").asText()));
    assertEquals(current, postJson(base + "/sops/save", edit(current, "设备清洁流程"), 200));
    assertEquals(history, versions(current));
  }

  @Test
  void invalidAxesAndEnabledDirectionCollisionsCannotPartiallySaveAnything() throws Exception {
    ObjectNode valid = boardSettings(true, true, 540, 1080);
    ((ObjectNode) valid.path("timeline")).put("axis", "y");
    ((ObjectNode) valid.path("priority")).put("axis", "x");
    JsonNode first = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(valid)), 200);
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    List<ObjectNode> invalid = new ArrayList<>();
    for (String section : List.of("timeline", "priority")) {
      for (JsonNode value : List.of(json.getNodeFactory().textNode("z"),
          json.getNodeFactory().textNode("X"), json.getNodeFactory().textNode(""),
          json.getNodeFactory().numberNode(1), json.getNodeFactory().booleanNode(true),
          json.nullNode(), json.createObjectNode(), json.createArrayNode())) {
        ObjectNode settings = boardSettings(false, false, 540, 1080);
        ((ObjectNode) settings.path(section)).set("axis", value);
        invalid.add(settings);
      }
    }
    for (String direction : List.of("x", "y")) {
      ObjectNode settings = boardSettings(true, true, 540, 1080);
      ((ObjectNode) settings.path("timeline")).put("axis", direction);
      ((ObjectNode) settings.path("priority")).put("axis", direction);
      invalid.add(settings);
    }
    for (ObjectNode settings : invalid) {
      String encoded = json.writeValueAsString(settings);
      postJson(base + "/sops/save", edit(first, "不应保存的名称").put("boardSettings", encoded), 400);
      postJson(base + "/sops/save", payload("不应创建的流程", steps()).put("boardSettings", encoded), 400);
    }
    assertEquals(first, stored(first));
    assertEquals(1, request(get(base + "/sops"), 200).size());
    assertEquals(history, versions(first));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }

  @Test
  void canvasSizeChangesSnapshotWithoutChangingAxesAndOlderAxisUpdatesPreserveTheSavedCanvas()
      throws Exception {
    ObjectNode originalSettings = boardSettings(true, true, 1380, 60);
    ((ObjectNode) originalSettings.path("timeline")).put("axis", "y");
    ((ObjectNode) originalSettings.path("priority")).put("axis", "x");
    originalSettings.putObject("custom").put("keep", "保留额外设置");
    JsonNode current = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(originalSettings)), 200);
    JsonNode firstHistory = versions(current).get(0);
    JsonNode records = request(get(base + "/work-items"), 200);
    assertFalse(json.readTree(current.path("boardSettings").asText()).has("canvas"));
    List<JsonNode> snapshots = new ArrayList<>();
    snapshots.add(originalSettings.deepCopy());
    ObjectNode settings = originalSettings.deepCopy();
    for (int[] dimensions : List.of(new int[] {320, 2400}, new int[] {2400, 320},
        new int[] {1200, 640})) {
      settings.putObject("canvas").put("width", dimensions[0]).put("height", dimensions[1])
          .putObject("custom").put("keep", "保留画板额外设置");
      JsonNode changed = postJson(base + "/sops/save", edit(current, "设备清洁流程")
          .put("boardSettings", json.writeValueAsString(settings)), 200);
      assertTrue(changed.path("revision").asLong() > current.path("revision").asLong());
      assertEquals(settings, json.readTree(changed.path("boardSettings").asText()));
      assertEquals(changed, stored(changed));
      assertEquals(current.path("draft"), changed.path("draft"));
      assertEquals(records, request(get(base + "/work-items"), 200));
      snapshots.add(settings.deepCopy());
      current = changed;
    }

    ObjectNode axisUpdate = settings.deepCopy();
    axisUpdate.remove("canvas");
    ((ObjectNode) axisUpdate.path("timeline")).put("axis", "x");
    ((ObjectNode) axisUpdate.path("priority")).put("axis", "y");
    ObjectNode merged = axisUpdate.deepCopy();
    merged.set("canvas", settings.path("canvas").deepCopy());
    current = postJson(base + "/sops/save", edit(current, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(axisUpdate)), 200);
    assertEquals(merged, json.readTree(current.path("boardSettings").asText()));
    snapshots.add(merged.deepCopy());
    assertEquals(current, postJson(base + "/sops/save", edit(current, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(axisUpdate)), 200));
    assertEquals(current, postJson(base + "/sops/save", edit(current, "设备清洁流程"), 200));
    ObjectNode nullConfiguration = edit(current, "设备清洁流程");
    nullConfiguration.putNull("boardSettings");
    assertEquals(current, postJson(base + "/sops/save", nullConfiguration, 200));

    ObjectNode reset = merged.deepCopy();
    ((ObjectNode) reset.path("canvas")).put("width", 820).put("height", 820);
    current = postJson(base + "/sops/save", edit(current, "设备清洁流程")
        .put("boardSettings", json.writeValueAsString(reset)), 200);
    assertEquals(reset, json.readTree(current.path("boardSettings").asText()));
    snapshots.add(reset.deepCopy());
    assertEquals(records, request(get(base + "/work-items"), 200));
    assertEquals(steps(), json.readTree(current.path("draft").asText()));
    JsonNode history = versions(current);
    assertEquals(snapshots.size(), history.size());
    assertEquals(firstHistory, history.get(snapshots.size() - 1));
    for (int i = 0; i < snapshots.size(); i++)
      assertEquals(snapshots.get(i), json.readTree(
          history.get(snapshots.size() - 1 - i).path("boardSettings").asText()));
  }

  @Test
  void invalidCanvasShapesDimensionsAndExplicitNullCannotPartiallySaveAnything() throws Exception {
    ObjectNode valid = boardSettings(true, true, 540, 1080);
    valid.putObject("canvas").put("width", 1200).put("height", 640)
        .put("customPadding", "c".repeat(4000));
    JsonNode first = postJson(base + "/sops/save", payload("设备清洁流程", steps())
        .put("boardSettings", json.writeValueAsString(valid)), 200);
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    List<JsonNode> invalid = new ArrayList<>(List.of(json.nullNode(), json.createArrayNode(),
        json.getNodeFactory().textNode("1200x640"), json.createObjectNode(),
        json.createObjectNode().put("width", 820), json.createObjectNode().put("height", 820)));
    for (String dimension : List.of("width", "height")) {
      for (JsonNode value : List.of(json.getNodeFactory().numberNode(319),
          json.getNodeFactory().numberNode(2401), json.getNodeFactory().numberNode(-1),
          json.getNodeFactory().numberNode(820.5), json.getNodeFactory().numberNode(2147483648L),
          json.getNodeFactory().textNode("820"), json.getNodeFactory().booleanNode(true),
          json.nullNode())) {
        ObjectNode canvas = json.createObjectNode().put("width", 820).put("height", 820);
        canvas.set(dimension, value);
        invalid.add(canvas);
      }
    }
    for (JsonNode canvas : invalid) {
      ObjectNode settings = valid.deepCopy();
      settings.set("canvas", canvas);
      String encoded = json.writeValueAsString(settings);
      postJson(base + "/sops/save", edit(first, "不应保存的名称").put("boardSettings", encoded), 400);
      postJson(base + "/sops/save", payload("不应创建的流程", steps()).put("boardSettings", encoded), 400);
    }
    ObjectNode mergedOverflow = valid.deepCopy();
    mergedOverflow.remove("canvas");
    mergedOverflow.put("otherSettings", "x".repeat(5000));
    String withinIncomingLimit = json.writeValueAsString(mergedOverflow);
    assertTrue(withinIncomingLimit.length() < 8192);
    postJson(base + "/sops/save", edit(first, "合并后过长也不应保存")
        .put("boardSettings", withinIncomingLimit), 400);
    assertEquals(first, stored(first));
    assertEquals(1, request(get(base + "/sops"), 200).size());
    assertEquals(history, versions(first));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }

  @Test
  void fourSideConnectionPortsRoundTripAcrossEditsAndHistoryWithoutChangingWorkRecordIdentity()
      throws Exception {
    var steps = json.createArrayNode();
    ObjectNode source = steps.addObject().put("kind", "MODULE")
        .put("id", "source").put("title", "开始工作");
    var targets = source.putArray("nextModuleIds");
    ObjectNode ports = source.putObject("connectionPorts");
    List<String> sides = List.of("top", "right", "bottom", "left");
    for (int index = 0; index < sides.size(); index++) {
      String side = sides.get(index), targetId = "target-" + side;
      targets.add(targetId);
      ports.putObject(targetId).put("source", side).put("target", sides.get((index + 2) % 4));
      ObjectNode target = steps.addObject().put("kind", "MODULE")
          .put("id", targetId).put("title", "工作 " + (index + 1));
      if (side.equals("top")) {
        target.putArray("nextModuleIds").add("target-right");
        target.putObject("connectionPorts").putObject("target-right").put("source", "top");
      } else if (side.equals("left")) {
        target.putArray("nextModuleIds").add("target-bottom");
      }
    }
    steps.addObject().put("kind", "DETAIL").put("title", "开始工作")
        .putArray("items").addObject().put("id", "instruction").put("text", "原有具体做法");
    JsonNode first = postJson(base + "/sops/save", payload("四边箭头流程", steps), 200);
    JsonNode originalRecords = request(get(base + "/work-items"), 200);
    assertEquals(5, originalRecords.size());
    assertEquals(steps, json.readTree(stored(first).path("draft").asText()));
    JsonNode firstHistory = versions(first).get(0);
    assertEquals(steps, json.readTree(firstHistory.path("steps").asText()));

    JsonNode changedSteps = steps.deepCopy();
    ObjectNode changedPorts = (ObjectNode) changedSteps.get(0).path("connectionPorts");
    ((ObjectNode) changedPorts.path("target-top")).put("source", "left").remove("target");
    ((ObjectNode) changedPorts.path("target-right")).put("target", "top");
    ObjectNode change = payload("四边箭头流程", changedSteps)
        .put("id", first.path("id").asText())
        .put("expectedRevision", first.path("revision").asLong());
    JsonNode updated = postJson(base + "/sops/save", change, 200);
    assertTrue(updated.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(changedSteps, json.readTree(stored(updated).path("draft").asText()));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
    JsonNode history = versions(updated);
    assertEquals(2, history.size());
    assertEquals(changedSteps, json.readTree(history.get(0).path("steps").asText()));
    assertEquals(firstHistory, history.get(1));
    change.put("expectedRevision", updated.path("revision").asLong());
    assertEquals(updated, postJson(base + "/sops/save", change, 200));
    assertEquals(history, versions(updated));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
  }
}
