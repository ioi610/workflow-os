package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:workflow-links;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
})
@AutoConfigureMockMvc
class WorkflowLinksIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate jdbc;
  MockHttpSession session;
  String base;
  UUID org;

  @BeforeEach
  void workspace() throws Exception {
    session = new MockHttpSession();
    postJson("/api/auth/register", Map.of("email", UUID.randomUUID() + "@test.com",
        "password", "SecurePass123!", "displayName", "做法关联测试"), 200);
    org = UUID.fromString(postJson("/api/organizations", Map.of("name", "关联保护"), 200)
        .path("id").asText());
    base = "/api/orgs/" + org;
  }

  JsonNode request(MockHttpServletRequestBuilder builder, int expected) throws Exception {
    var response = mvc.perform(builder.session(session).with(csrf()).contentType("application/json"))
        .andReturn().getResponse();
    assertEquals(expected, response.getStatus(), response.getContentAsString());
    return response.getContentAsByteArray().length == 0
        ? json.nullNode() : json.readTree(response.getContentAsString());
  }

  JsonNode postJson(String path, Object body, int expected) throws Exception {
    return request(post(path).content(json.writeValueAsString(body)), expected);
  }

  ObjectNode module(String id, String name) {
    return json.createObjectNode().put("kind", "MODULE").put("id", id).put("title", name);
  }

  ObjectNode document(String id, String name) {
    ObjectNode document = json.createObjectNode().put("kind", "DETAIL").put("id", id).put("title", name);
    document.putArray("items").addObject().put("id", "step-" + id).put("text", "保留原来手写的做法");
    return document;
  }

  ArrayNode steps(JsonNode... entries) {
    return json.createArrayNode().addAll(Arrays.asList(entries));
  }

  ObjectNode body(String title, JsonNode steps) {
    ObjectNode body = json.createObjectNode().put("title", title).put("category", "日常");
    body.set("steps", steps);
    return body;
  }

  ObjectNode edit(JsonNode workflow, JsonNode steps) {
    return body(workflow.path("title").asText(), steps).put("id", workflow.path("id").asText())
        .put("expectedRevision", workflow.path("revision").asLong()).put("draftOnly", true);
  }

  JsonNode create(String title, JsonNode... entries) throws Exception {
    return postJson(base + "/sops/save", body(title, steps(entries)), 200);
  }

  JsonNode source(String title) throws Exception {
    return create(title, module("source-work", "准备材料"), document("source-doc", "准备材料"));
  }

  String path(JsonNode workflow) {
    return base + "/sops/" + workflow.path("id").asText();
  }

  JsonNode remove(JsonNode workflow, int expected) throws Exception {
    return request(delete(path(workflow)).content(json.writeValueAsString(
        Map.of("expectedRevision", workflow.path("revision").asLong()))), expected);
  }

  JsonNode stored(JsonNode workflow) throws Exception {
    for (JsonNode item : request(get(base + "/sops"), 200))
      if (item.path("id").equals(workflow.path("id"))) return item;
    fail("流程不应被删除");
    return null;
  }

  ArrayNode content(JsonNode workflow) throws Exception {
    return (ArrayNode) json.readTree(workflow.path("draft").asText());
  }

  JsonNode versions(JsonNode workflow) throws Exception {
    return request(get(path(workflow) + "/versions"), 200);
  }

  @Test
  void deletingSourceListsPinnedIdPinnedNameAndUniqueAutomaticAndLegacyConsumersWithoutChangingData()
      throws Exception {
    JsonNode source = source("共享来源");
    String sourceId = source.path("id").asText();
    JsonNode pinnedId = create("稳定绑定流程", module("bound", "另一个工作名")
        .put("detailWorkflowId", sourceId).put("detailId", "source-doc"));
    JsonNode pinnedName = create("旧名字绑定流程", module("named", "准备材料")
        .put("detailWorkflowId", sourceId));
    JsonNode automatic = create("自动对应流程", module("automatic", "准备材料"));
    JsonNode legacy = create("旧格式流程", json.createObjectNode().put("id", "legacy-work")
        .put("title", "旧工作名").put("detailName", "准备材料").put("description", "旧格式原文"));
    JsonNode before = request(get(base + "/sops"), 200);
    JsonNode history = versions(source);
    JsonNode records = request(get(base + "/work-items"), 200);

    String message = remove(source, 409).path("message").asText();
    for (String name : List.of("稳定绑定流程", "旧名字绑定流程", "自动对应流程", "旧格式流程", "另一个工作名"))
      assertTrue(message.contains(name), message);
    assertEquals(before, request(get(base + "/sops"), 200));
    assertEquals(history, versions(source));
    assertEquals(records, request(get(base + "/work-items"), 200));
    assertEquals(0, jdbc.queryForObject("select count(*) from audit_logs where resource_id=? and action='SOP_DELETE'",
        Integer.class, UUID.fromString(sourceId)));

    for (JsonNode consumer : List.of(pinnedId, pinnedName, automatic, legacy)) remove(consumer, 204);
    remove(source, 204);
    assertEquals(0, jdbc.queryForObject("select count(*) from sop_versions where sop_id=?",
        Integer.class, UUID.fromString(sourceId)));
  }

  @Test
  void deletionIgnoresLocalShadowsAmbiguousNamesDetailExtensionsAndReferencesFromAnotherOrganization()
      throws Exception {
    JsonNode source = source("可以删除的来源");
    ObjectNode shadowDoc = document("local-doc", "准备材料");
    shadowDoc.put("detailWorkflowId", source.path("id").asText()); // DETAIL extension is not a module reference.
    JsonNode shadow = create("已有本地做法", module("local", "准备材料"), shadowDoc);
    JsonNode ambiguous = create("未指定来源且重名", module("ambiguous", "准备材料"));
    JsonNode localIdOnly = create("失联的本地编号", module("local-id", "准备材料"));
    ArrayNode oldLocal = content(localIdOnly);
    ((ObjectNode) oldLocal.get(0)).put("detailId", "source-doc");
    jdbc.update("update sops set draft=? where id=?", oldLocal.toString(), UUID.fromString(localIdOnly.path("id").asText()));
    String otherBase = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "另一个工作区"), 200)
        .path("id").asText();
    JsonNode other = postJson(otherBase + "/sops/save", body("别的工作区的旧数据", steps(module("other", "其他工作"))), 200);
    ArrayNode oldOther = content(other);
    ((ObjectNode) oldOther.get(0)).put("detailWorkflowId", source.path("id").asText());
    jdbc.update("update sops set draft=? where id=?", oldOther.toString(), UUID.fromString(other.path("id").asText()));

    remove(source, 204);
    assertEquals(shadow, stored(shadow));
    assertEquals(ambiguous, stored(ambiguous));
    assertEquals(oldLocal, content(stored(localIdOnly)));
    assertEquals(oldOther, content(request(get(otherBase + "/sops"), 200).get(0)));
  }

  @Test
  void localStableBindingRoundTripsWithExtensionsAndRejectsInvalidIdShapesAtomically() throws Exception {
    ObjectNode work = module("work", "另一个显示名称").put("detailId", " doc-with-spaces ");
    work.putObject("custom").put("keep", "原有扩展数据");
    work.putObject("frame").put("x", 4).put("y", 5).put("width", 164).put("height", 164);
    JsonNode first = create("稳定本地绑定", work, document(" doc-with-spaces ", "原做法名称"));
    JsonNode history = versions(first);
    JsonNode records = request(get(base + "/work-items"), 200);
    assertEquals(steps(work, document(" doc-with-spaces ", "原做法名称")), content(stored(first)));
    assertEquals(content(first), json.readTree(history.get(0).path("steps").asText()));
    for (JsonNode invalid : List.of(json.nullNode(), json.createArrayNode(), json.createObjectNode(),
        json.getNodeFactory().numberNode(1), json.getNodeFactory().textNode(""),
        json.getNodeFactory().textNode(" \t "), json.getNodeFactory().textNode("x".repeat(256)))) {
      ArrayNode changed = content(first);
      ((ObjectNode) changed.get(0)).set("detailId", invalid);
      postJson(base + "/sops/save", edit(first, changed).put("title", "不应保存"), 400);
      assertEquals(first, stored(first));
      assertEquals(history, versions(first));
      assertEquals(records, request(get(base + "/work-items"), 200));
    }
  }

  @Test
  void newOrChangedBindingsRequireExistingAccessibleSourcesAndDocumentsButOldBrokenBindingsRemainEditable()
      throws Exception {
    JsonNode first = create("还没有绑定的流程", module("work", "准备材料"));
    String otherBase = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "其他工作区"), 200)
        .path("id").asText();
    JsonNode inaccessible = postJson(otherBase + "/sops/save", body("不能跨工作区使用", steps(document("other-doc", "准备材料"))), 200);
    for (ObjectNode work : List.of(
        module("work", "准备材料").put("detailWorkflowId", UUID.randomUUID().toString()),
        module("work", "准备材料").put("detailWorkflowId", inaccessible.path("id").asText()).put("detailId", "other-doc"),
        module("work", "准备材料").put("detailId", "missing-local-doc"))) {
      postJson(base + "/sops/save", edit(first, steps(work)), 409);
      assertEquals(first, stored(first));
    }
    ArrayNode legacyBroken = content(first);
    ((ObjectNode) legacyBroken.get(0)).put("detailWorkflowId", UUID.randomUUID().toString())
        .put("detailId", "already-missing");
    jdbc.update("update sops set draft=? where id=?", legacyBroken.toString(), UUID.fromString(first.path("id").asText()));
    JsonNode old = stored(first);
    JsonNode changed = postJson(base + "/sops/save", edit(old, legacyBroken).put("title", "仍可保存其他修改"), 200);
    assertEquals(legacyBroken, content(changed));
    assertTrue(changed.path("revision").asLong() > old.path("revision").asLong());
    ArrayNode newBroken = legacyBroken.deepCopy();
    ((ObjectNode) newBroken.get(0)).put("detailId", "another-missing");
    postJson(base + "/sops/save", edit(changed, newBroken), 409);
    assertEquals(changed, stored(changed));
  }

  @Test
  void renamingSourceIncludingTemporarilyBlankNameStabilizesOldReferencesWithoutPublishingOrChangingWorkIdentity()
      throws Exception {
    JsonNode source = source("改名来源");
    String sourceId = source.path("id").asText();
    ObjectNode namedWork = module("named", "准备材料");
    namedWork.putObject("custom").put("original", true);
    namedWork.putObject("frame").put("x", 20).put("y", 30).put("width", 164).put("height", 164);
    JsonNode automatic = create("旧自动对应", namedWork);
    JsonNode pinned = create("旧来源绑定", module("pinned", "显示名称")
        .put("detailWorkflowId", sourceId).put("detailName", "准备材料"));
    JsonNode legacy = create("旧格式引用", json.createObjectNode().put("id", "legacy")
        .put("title", "旧显示名称").put("detailName", "准备材料").put("description", "原有说明"));
    JsonNode stable = create("已有稳定绑定", module("stable", "自己的名称")
        .put("detailWorkflowId", sourceId).put("detailId", "source-doc"));
    List<JsonNode> consumers = List.of(automatic, pinned, legacy);
    Map<String, JsonNode> histories = new HashMap<>();
    for (JsonNode consumer : consumers) histories.put(consumer.path("id").asText(), versions(consumer));
    JsonNode originalRecords = request(get(base + "/work-items"), 200);
    JsonNode sourceHistory = versions(source);
    ArrayNode blankName = content(source);
    ((ObjectNode) blankName.get(1)).put("title", " \t ");

    JsonNode changed = postJson(base + "/sops/save", edit(source, blankName), 200);
    for (JsonNode consumer : consumers) {
      JsonNode current = stored(consumer);
      ObjectNode expected = content(consumer).get(0).deepCopy();
      expected.put("detailWorkflowId", sourceId).put("detailId", "source-doc");
      assertEquals(expected, content(current).get(0));
      assertTrue(current.path("revision").asLong() > consumer.path("revision").asLong());
      assertEquals(histories.get(consumer.path("id").asText()), versions(current));
    }
    assertEquals("source-doc", content(changed).get(0).path("detailId").asText());
    assertEquals(stable, stored(stable));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
    assertEquals(sourceHistory, versions(changed));
    postJson(base + "/sops/save", edit(automatic, content(automatic)), 409);

    JsonNode migrated = stored(automatic);
    ArrayNode finalName = content(changed);
    ((ObjectNode) finalName.get(1)).put("title", "后来正式起的名字");
    postJson(base + "/sops/save", edit(changed, finalName), 200);
    assertEquals(migrated, stored(migrated));
    assertEquals(originalRecords, request(get(base + "/work-items"), 200));
  }

  @Test
  void removingSharedDocumentIsBlockedUntilAllSubmittedAndExternalUsersAreRemoved() throws Exception {
    JsonNode source = source("保留共享正文");
    JsonNode consumer = create("还在使用的流程", module("consumer", "引用的工作")
        .put("detailWorkflowId", source.path("id").asText()).put("detailId", "source-doc"));
    JsonNode history = versions(source);
    JsonNode records = request(get(base + "/work-items"), 200);
    String message = postJson(base + "/sops/save", edit(source, steps()), 409).path("message").asText();
    assertTrue(message.contains("还在使用的流程") && message.contains("引用的工作"), message);
    assertEquals(source, stored(source));
    assertEquals(history, versions(source));
    assertEquals(records, request(get(base + "/work-items"), 200));
    JsonNode onlyDocument = postJson(base + "/sops/save", edit(source, steps(content(source).get(1))), 200);
    assertEquals(content(source).get(1), content(onlyDocument).get(0));
    postJson(base + "/sops/save", edit(onlyDocument, steps()), 409);
    postJson(base + "/sops/save", edit(consumer, steps()), 200);
    JsonNode empty = postJson(base + "/sops/save", edit(onlyDocument, steps()), 200);
    assertTrue(content(empty).isEmpty());
    assertEquals(history, versions(empty));
  }

  @Test
  void localDocumentRemovalUsesSubmittedModulesSoRemovingLastWorkAndItsDocumentTogetherSucceeds()
      throws Exception {
    JsonNode first = source("只有本地引用");
    source("另一个流程也有同名做法");
    String message = postJson(base + "/sops/save", edit(first, steps(content(first).get(0))), 409)
        .path("message").asText();
    assertTrue(message.contains("只有本地引用") && message.contains("准备材料"), message);
    assertEquals(first, stored(first));
    JsonNode empty = postJson(base + "/sops/save", edit(first, steps()), 200);
    assertTrue(content(empty).isEmpty());
    for (JsonNode item : request(get(base + "/work-items"), 200))
      assertNotEquals(first.path("id"), item.path("workflowId"));
  }

  @Test
  void legacySourceDocumentIdsAndNormalizedNamesUseTheSameReaderCompatibilityRules() throws Exception {
    JsonNode source = create("旧格式来源", json.createObjectNode().put("id", "legacy-source")
        .put("title", "Cafe\u0301").put("description", "原有操作"));
    JsonNode automatic = create("名称规范化引用", module("auto", "\u00a0Caf\u00e9\ufeff"));
    JsonNode idBound = create("旧编号引用", module("bound", "自己的名称")
        .put("detailWorkflowId", source.path("id").asText()).put("detailId", "detail-legacy-source"));
    String message = remove(source, 409).path("message").asText();
    assertTrue(message.contains("名称规范化引用") && message.contains("旧编号引用"), message);
    ArrayNode modern = steps(module("module-legacy-source", "Caf\u00e9"),
        document("detail-legacy-source", "新的做法名"));
    postJson(base + "/sops/save", edit(source, modern), 200);
    assertEquals("detail-legacy-source", content(stored(automatic)).get(0).path("detailId").asText());
    assertEquals(idBound, stored(idBound));
  }

  @Test
  void pickingAnIdlessDocumentMaterializesItsSourceIdentityBeforeOtherRowsMoveWithoutChangingContentOrHistory()
      throws Exception {
    for (boolean legacy : List.of(false, true)) {
      String name = legacy ? "旧格式操作" : "无编号具体做法";
      String documentId = legacy ? "detail-legacy-0" : "detail-2";
      ObjectNode original = legacy
          ? json.createObjectNode().put("title", name).put("description", "原有步骤文字")
          : document("unused", name);
      original.remove("id");
      original.putObject("custom").put("original", "保留扩展数据");
      original.put("imageUrl", "https://example.com/original.png");
      JsonNode source = legacy ? create("旧格式来源", original)
          : create("旧详细做法来源", module("lead", "另一项工作"), module("original", name), original);
      JsonNode history = versions(source);
      JsonNode beforeRecords = request(get(base + "/work-items"), 200);
      Map<String, JsonNode> sourceRecords = new HashMap<>();
      for (JsonNode record : beforeRecords)
        if (record.path("workflowId").equals(source.path("id")))
          sourceRecords.put(record.path("moduleId").asText(), record);
      JsonNode consumer = create("新选中的引用" + legacy, module("picked", "引用的显示名称")
          .put("detailWorkflowId", source.path("id").asText()).put("detailId", documentId));
      JsonNode stableSource = stored(source);
      assertTrue(stableSource.path("revision").asLong() > source.path("revision").asLong());
      assertEquals(history, versions(stableSource));
      ObjectNode expectedDocument = original.deepCopy().put("id", legacy ? "legacy-0" : documentId);
      assertEquals(expectedDocument, content(stableSource).get(legacy ? 0 : 2));
      for (JsonNode record : request(get(base + "/work-items"), 200))
        if (record.path("workflowId").equals(source.path("id")))
          assertEquals(sourceRecords.get(record.path("moduleId").asText()), record);

      ArrayNode shifted = content(stableSource);
      if (legacy) shifted.insert(0, module("lead", "新添在前面的工作"));
      else shifted.remove(0);
      JsonNode moved = postJson(base + "/sops/save", edit(stableSource, shifted), 200);
      assertEquals(expectedDocument, content(moved).get(1));
      assertEquals(consumer, stored(consumer));
      String originalModule = legacy ? "module-legacy-0" : "original";
      for (JsonNode record : request(get(base + "/work-items"), 200))
        if (record.path("workflowId").equals(source.path("id"))
            && record.path("moduleId").asText().equals(originalModule))
          assertEquals(sourceRecords.get(originalModule).path("id"), record.path("id"));
      assertTrue(remove(moved, 409).path("message").asText().contains("新选中的引用" + legacy));
    }
  }

  @Test
  void concurrentSourceDeletionAndNewBindingCannotBothSucceed() throws Exception {
    JsonNode source = source("并发来源");
    JsonNode consumer = create("并发使用者");
    ObjectNode bound = module("new-work", "准备材料").put("detailWorkflowId", source.path("id").asText())
        .put("detailId", "source-doc");
    String saveBody = json.writeValueAsString(edit(consumer, steps(bound)));
    String deleteBody = json.writeValueAsString(Map.of("expectedRevision", source.path("revision").asLong()));
    CyclicBarrier start = new CyclicBarrier(2);
    try (ExecutorService pool = Executors.newFixedThreadPool(2)) {
      Future<Integer> saved = pool.submit(() -> {
        start.await(10, TimeUnit.SECONDS);
        return mvc.perform(post(base + "/sops/save").session(session).with(csrf())
            .contentType("application/json").content(saveBody)).andReturn().getResponse().getStatus();
      });
      Future<Integer> deleted = pool.submit(() -> {
        start.await(10, TimeUnit.SECONDS);
        return mvc.perform(delete(path(source)).session(session).with(csrf())
            .contentType("application/json").content(deleteBody)).andReturn().getResponse().getStatus();
      });
      int saveStatus = saved.get(20, TimeUnit.SECONDS), deleteStatus = deleted.get(20, TimeUnit.SECONDS);
      assertTrue(saveStatus == 200 && deleteStatus == 409 || saveStatus == 409 && deleteStatus == 204,
          "save=" + saveStatus + ", delete=" + deleteStatus);
      if (saveStatus == 200) {
        assertEquals(source, stored(source));
        assertEquals(steps(bound), content(stored(consumer)));
      } else assertEquals(consumer, stored(consumer));
    }
  }
}
