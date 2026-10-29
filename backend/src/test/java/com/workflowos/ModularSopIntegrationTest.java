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

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:modular-sop;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    })
@AutoConfigureMockMvc
class ModularSopIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate jdbc;
  MockHttpSession session;
  String base;

  @BeforeEach
  void workspace() throws Exception {
    session = new MockHttpSession();
    postJson(
        "/api/auth/register",
        Map.of(
            "email", UUID.randomUUID() + "@test.com",
            "password", "SecurePass123!",
            "displayName", "手册作者"),
        200);
    base =
        "/api/orgs/"
            + postJson("/api/organizations", Map.of("name", "模块化手册"), 200)
                .path("id")
                .asText();
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

  ObjectNode payload(JsonNode steps) {
    ObjectNode body = json.createObjectNode().put("title", "开店流程").put("category", "日常");
    body.set("steps", steps);
    return body;
  }

  ObjectNode edit(JsonNode sop, JsonNode steps) {
    return payload(steps)
        .put("id", sop.path("id").asText())
        .put("expectedRevision", sop.path("revision").asLong());
  }

  ObjectNode module(String title) {
    return json.createObjectNode()
        .put("kind", "MODULE")
        .put("id", UUID.randomUUID().toString())
        .put("title", title);
  }

  ObjectNode detail(String title) {
    ObjectNode detail =
        json.createObjectNode()
            .put("kind", "DETAIL")
            .put("id", UUID.randomUUID().toString())
            .put("title", title);
    detail.putArray("items")
        .addObject()
        .put("id", UUID.randomUUID().toString())
        .put("text", "按顺序清洗并晾干设备。");
    return detail;
  }

  ArrayNode linkedSteps() {
    return json.createArrayNode().add(module(" 清洁设备 ")).add(detail("清洁设备"));
  }

  JsonNode versions(JsonNode sop) throws Exception {
    return request(get(base + "/sops/" + sop.path("id").asText() + "/versions"), 200);
  }

  JsonNode stored(JsonNode sop) throws Exception {
    for (JsonNode entry : request(get(base + "/sops"), 200))
      if (entry.path("id").equals(sop.path("id"))) return entry;
    throw new AssertionError("流程未保存");
  }

  @Test
  void modulesAndIndependentDetailListsRoundTripWithoutRewritingNamesOrContent() throws Exception {
    ArrayNode steps = linkedSteps();
    steps.add(module("下一项待编写"));
    ObjectNode standalone =
        detail("独立参考做法").put("description", "保留补充说明").put("safetyNotice", "先断电");
    standalone.putArray("materials").add("软布");
    standalone.put("imageUrl", "https://example.com/guide.png");
    standalone.put("videoUrl", "https://example.com/guide.mp4");
    steps.add(standalone);

    JsonNode first = postJson(base + "/sops/save", payload(steps), 200);
    assertEquals("PUBLISHED", first.path("status").asText());
    assertEquals(steps, json.readTree(stored(first).path("draft").asText()));
    assertEquals(steps, json.readTree(versions(first).get(0).path("steps").asText()));
    JsonNode repeated = postJson(base + "/sops/save", edit(first, steps), 200);
    assertEquals(first, repeated);
    assertEquals(1, versions(first).size());

    ((ArrayNode) standalone.path("items"))
        .addObject().put("id", "second").put("text", "检查部件后重新组装。");
    JsonNode edited = postJson(base + "/sops/save", edit(first, steps), 200);
    assertEquals(steps, json.readTree(stored(edited).path("draft").asText()));
    assertEquals(2, versions(edited).size());
    assertEquals(
        1, json.readTree(versions(edited).get(1).path("steps").asText()).get(3).path("items").size());
  }

  @Test
  void duplicateNormalizedNamesAreRejectedWithinEachKindAndSavedContentIsUnchanged() throws Exception {
    JsonNode saved = postJson(base + "/sops/save", payload(linkedSteps()), 200);
    for (String kind : List.of("MODULE", "DETAIL")) {
      ArrayNode duplicate = json.createArrayNode();
      duplicate.add(kind.equals("MODULE") ? module(" Café ") : detail(" Café "));
      duplicate.add(kind.equals("MODULE") ? module("Cafe\u0301") : detail("Cafe\u0301"));
      postJson(base + "/sops/save", edit(saved, duplicate), 400);
      assertEquals(saved, stored(saved));
      assertEquals(1, versions(saved).size());
    }
    ArrayNode caseSensitive =
        json.createArrayNode()
            .add(module("Wash")).add(module("wash"))
            .add(detail("Wash")).add(detail("wash"));
    postJson(base + "/sops/save", edit(saved, caseSensitive), 200);
  }

  @Test
  void pastedUnicodeSpacesMatchFrontendTrimWithoutChangingSavedTitles() throws Exception {
    String padding =
        "\t\n\u000B\f\r \u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF";
    assertEquals("Café", WorkspaceController.normalizeStepName(padding + "Cafe\u0301" + padding));
    for (String kind : List.of("MODULE", "DETAIL")) {
      ArrayNode duplicate = json.createArrayNode();
      duplicate.add(
          kind.equals("MODULE")
              ? module(padding + "Café" + padding)
              : detail(padding + "Café" + padding));
      duplicate.add(kind.equals("MODULE") ? module("Cafe\u0301") : detail("Cafe\u0301"));
      postJson(base + "/sops/save", payload(duplicate), 400);
      ArrayNode blank =
          json.createArrayNode().add(kind.equals("MODULE") ? module(padding) : detail(padding));
      postJson(base + "/sops/save", payload(blank), 400);
    }

    ArrayNode preserved =
        json.createArrayNode().add(module("\u00A0清洁设备\uFEFF")).add(detail("清洁设备"));
    JsonNode saved = postJson(base + "/sops/save", payload(preserved), 200);
    assertEquals(preserved, json.readTree(stored(saved).path("draft").asText()));
    assertEquals(preserved, json.readTree(versions(saved).get(0).path("steps").asText()));

    // Java strip() would remove these characters; ECMAScript trim() retains them.
    for (char control = '\u001C'; control <= '\u001F'; control++)
      assertEquals(
          control + "清洁设备" + control,
          WorkspaceController.normalizeStepName(control + "清洁设备" + control));
    ArrayNode distinct =
        json.createArrayNode().add(module("\u001C清洁设备\u001F")).add(module("清洁设备"));
    postJson(base + "/sops/save", edit(saved, distinct), 200);
  }

  @Test
  void malformedKindsAndDetailListsCannotCreateOrOverwriteAWorkflow() throws Exception {
    JsonNode saved = postJson(base + "/sops/save", payload(linkedSteps()), 200);
    List<ObjectNode> invalid = new ArrayList<>();
    invalid.add(module("未知类型").put("kind", "OTHER"));
    invalid.add(module("空类型").putNull("kind"));
    ObjectNode missing = detail("缺少清单");
    missing.remove("items");
    invalid.add(missing);
    invalid.add(detail("错误清单").put("items", "清洗"));
    ObjectNode empty = detail("空清单");
    empty.set("items", json.createArrayNode());
    invalid.add(empty);
    for (JsonNode item :
        List.of(
            json.createObjectNode(),
            json.createObjectNode().put("text", " \n "),
            json.createObjectNode().put("text", 42),
            json.createObjectNode().putNull("text"))) {
      ObjectNode badItem = detail("无效做法");
      badItem.set("items", json.createArrayNode().add(item));
      invalid.add(badItem);
    }
    for (ObjectNode entry : invalid) {
      ArrayNode badSteps = json.createArrayNode().add(entry);
      postJson(base + "/sops/save", payload(badSteps), 400);
      postJson(base + "/sops/save", edit(saved, badSteps), 400);
    }
    assertEquals(1, request(get(base + "/sops"), 200).size());
    assertEquals(saved, stored(saved));
    assertEquals(1, versions(saved).size());
  }

  @Test
  void perKindAndDetailListLimitsAllowOneHundredButRejectOneHundredAndOne() throws Exception {
    ArrayNode steps = json.createArrayNode();
    for (int i = 0; i < 100; i++) steps.add(module("模块" + i)).add(detail("模块" + i));
    JsonNode saved = postJson(base + "/sops/save", payload(steps), 200);
    assertEquals(200, json.readTree(saved.path("draft").asText()).size());
    steps.add(module("模块100"));
    postJson(base + "/sops/save", edit(saved, steps), 400);
    for (String kind : List.of("MODULE", "DETAIL")) {
      ArrayNode excess = json.createArrayNode();
      for (int i = 0; i < 101; i++)
        excess.add(kind.equals("MODULE") ? module("步骤" + i) : detail("步骤" + i));
      postJson(base + "/sops/save", payload(excess), 400);
    }
    ObjectNode longDetail = detail("完整清单");
    ArrayNode items = (ArrayNode) longDetail.path("items");
    for (int i = 1; i < 100; i++) items.addObject().put("id", "item-" + i).put("text", "做法" + i);
    postJson(base + "/sops/save", payload(json.createArrayNode().add(longDetail)), 200);
    items.addObject().put("id", "item-100").put("text", "超出上限");
    postJson(base + "/sops/save", payload(json.createArrayNode().add(longDetail)), 400);
  }

  @Test
  void legacyEntriesAndCustomFieldsRemainCompatibleBesideModules() throws Exception {
    JsonNode legacy = json.readTree("""
        {"title":"旧版清洁","description":"原有长说明","materials":["软布"],
         "custom":{"sequence":["断电","清洁"]},"notes":"原有备注"}
        """);
    ArrayNode steps = linkedSteps().add(legacy).add(legacy.deepCopy());
    JsonNode saved = postJson(base + "/sops/save", payload(steps), 200);
    assertEquals(steps, json.readTree(stored(saved).path("draft").asText()));
    assertEquals(steps, json.readTree(versions(saved).get(0).path("steps").asText()));
  }

  @Test
  void draftCreationEditingAndPublishingUseTheSameModuleValidation() throws Exception {
    ArrayNode invalid = json.createArrayNode().add(module("重复")).add(module(" 重复 "));
    postJson(base + "/sops", payload(invalid), 400);
    JsonNode draft = postJson(base + "/sops", payload(linkedSteps()), 200);
    String path = base + "/sops/" + draft.path("id").asText();
    request(put(path).content(json.writeValueAsString(payload(invalid))), 400);
    assertEquals(draft, stored(draft));
    ObjectNode changed = payload(json.createArrayNode().add(module("独立模块")));
    request(put(path).content(json.writeValueAsString(changed)), 200);
    postJson(path + "/publish", Map.of(), 200);
    assertEquals(1, versions(draft).size());

    // Old stored drafts are revalidated before publication as well.
    jdbc.update(
        "update sops set draft=? where id=?",
        json.writeValueAsString(invalid),
        UUID.fromString(draft.path("id").asText()));
    postJson(path + "/publish", Map.of(), 400);
    assertEquals(1, versions(draft).size());
  }
}
