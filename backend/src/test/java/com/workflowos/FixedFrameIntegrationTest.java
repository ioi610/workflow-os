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
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:fixed-frame;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
})
@AutoConfigureMockMvc
class FixedFrameIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  MockHttpSession session;
  String base;

  @BeforeEach
  void workspace() throws Exception {
    session = new MockHttpSession();
    postJson("/api/auth/register", Map.of("email", UUID.randomUUID() + "@test.com",
        "password", "SecurePass123!", "displayName", "画板作者"), 200);
    base = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "固定方框"), 200)
        .path("id").asText();
  }

  JsonNode request(MockHttpServletRequestBuilder builder, int expected) throws Exception {
    var response = mvc.perform(builder.session(session).with(csrf()).contentType("application/json"))
        .andReturn().getResponse();
    assertEquals(expected, response.getStatus(), response.getContentAsString());
    return json.readTree(response.getContentAsString());
  }

  JsonNode postJson(String path, Object body, int expected) throws Exception {
    return request(post(path).content(json.writeValueAsString(body)), expected);
  }

  ObjectNode module(String id) {
    return json.createObjectNode().put("kind", "MODULE").put("id", id).put("title", "工作 " + id);
  }

  ObjectNode frame(double x, double y, double width, double height) {
    return json.createObjectNode().put("x", x).put("y", y).put("width", width).put("height", height);
  }

  ObjectNode settings(int width, int height) {
    ObjectNode value = json.createObjectNode().put("version", 1);
    value.putObject("timeline").put("enabled", true).put("startMinute", 540).put("endMinute", 1080);
    value.putObject("priority").put("enabled", true);
    value.putObject("canvas").put("width", width).put("height", height);
    return value;
  }

  ObjectNode body(JsonNode steps) {
    ObjectNode value = json.createObjectNode().put("title", "固定方框流程").put("category", "日常");
    value.set("steps", steps);
    return value;
  }

  ObjectNode edit(JsonNode saved, JsonNode steps) {
    return body(steps).put("id", saved.path("id").asText())
        .put("expectedRevision", saved.path("revision").asLong());
  }

  JsonNode stored(JsonNode saved) throws Exception {
    for (JsonNode entry : request(get(base + "/sops"), 200))
      if (entry.path("id").equals(saved.path("id"))) return entry;
    throw new AssertionError("没有找到已保存的流程");
  }

  JsonNode versions(JsonNode saved) throws Exception {
    return request(get(base + "/sops/" + saved.path("id").asText() + "/versions"), 200);
  }

  JsonNode records() throws Exception {
    return request(get(base + "/work-items"), 200);
  }

  @Test
  void convertedFramesStayFixedWhenBoardGrowsAndMergedReferenceAndCanvasKeepWorkIdentity()
      throws Exception {
    ObjectNode modern = module("modern");
    modern.putObject("position").put("x", 0.1).put("y", 0.2);
    modern.putObject("size").put("width", 0.2).put("height", 0.2);
    ObjectNode legacy = json.createObjectNode().put("id", "old")
        .put("title", "旧工作").put("description", "保留原有做法");
    ArrayNode original = json.createArrayNode().add(modern).add(legacy);
    JsonNode first = postJson(base + "/sops/save", body(original), 200);
    JsonNode originalRecords = records();
    JsonNode firstHistory = versions(first).get(0);
    assertEquals(2, originalRecords.size());

    ArrayNode converted = original.deepCopy();
    ObjectNode fixed = (ObjectNode) converted.get(0);
    fixed.remove("position");
    fixed.set("frame", frame(82, 164, 164, 164));
    // The fixed frame takes precedence over old ratio fields, including ratios below 0.12.
    fixed.putObject("size").put("width", 164.0 / 2400).put("height", 164.0 / 1400);
    ((ObjectNode) converted.get(1)).set("frame", frame(1900, 600, 120, 64));
    ObjectNode configuration = settings(2400, 1400);
    configuration.putObject("referenceCanvas").put("width", 820).put("height", 820)
        .put("custom", "保留原始缩放信息");
    JsonNode expanded = postJson(base + "/sops/save", edit(first, converted)
        .put("boardSettings", json.writeValueAsString(configuration)), 200);
    assertTrue(expanded.path("revision").asLong() > first.path("revision").asLong());
    assertEquals(converted, json.readTree(stored(expanded).path("draft").asText()));
    assertEquals(originalRecords, records());
    assertEquals(firstHistory, versions(expanded).get(1));

    ((ObjectNode) configuration.path("canvas")).put("height", 2400);
    JsonNode taller = postJson(base + "/sops/save", edit(expanded, converted)
        .put("boardSettings", json.writeValueAsString(configuration)), 200);
    assertEquals(expanded.path("draft"), taller.path("draft"));
    assertEquals(originalRecords, records());

    ObjectNode oldClientSettings = configuration.deepCopy();
    oldClientSettings.remove(List.of("canvas", "referenceCanvas"));
    ((ObjectNode) oldClientSettings.path("timeline")).put("axis", "y");
    ((ObjectNode) oldClientSettings.path("priority")).put("axis", "x");
    JsonNode reoriented = postJson(base + "/sops/save", edit(taller, converted)
        .put("boardSettings", json.writeValueAsString(oldClientSettings)), 200);
    JsonNode merged = json.readTree(reoriented.path("boardSettings").asText());
    assertEquals(configuration.path("canvas"), merged.path("canvas"));
    assertEquals(configuration.path("referenceCanvas"), merged.path("referenceCanvas"));
    assertEquals(converted, json.readTree(reoriented.path("draft").asText()));
    assertEquals(originalRecords, records());
    assertEquals(reoriented, postJson(base + "/sops/save", edit(reoriented, converted)
        .put("boardSettings", json.writeValueAsString(oldClientSettings)), 200));
    assertEquals(reoriented, postJson(base + "/sops/save", edit(reoriented, converted), 200));
    assertEquals(4, versions(reoriented).size());
    assertEquals(merged, json.readTree(versions(reoriented).get(0).path("boardSettings").asText()));
    assertEquals(converted, json.readTree(versions(reoriented).get(0).path("steps").asText()));

    String path = base + "/sops/" + reoriented.path("id").asText();
    request(put(path).content(json.writeValueAsString(body(converted))), 200);
    postJson(path + "/publish", Map.of(), 200);
    assertEquals(converted, json.readTree(stored(reoriented).path("draft").asText()));
    assertEquals(merged, json.readTree(versions(reoriented).get(0).path("boardSettings").asText()));
    assertEquals(originalRecords, records());
  }

  @Test
  void shrinkingPastAFixedFrameRollsBackBothStepsAndSettingsWhileAtomicRepositioningCanSucceed()
      throws Exception {
    ObjectNode fixed = module("fixed");
    fixed.set("frame", frame(1400, 300, 164, 164));
    ArrayNode original = json.createArrayNode().add(fixed).add(module("unchanged"));
    ObjectNode configuration = settings(2400, 1200);
    configuration.putObject("referenceCanvas").put("width", 820).put("height", 820);
    JsonNode saved = postJson(base + "/sops/save", body(original)
        .put("boardSettings", json.writeValueAsString(configuration)), 200);
    JsonNode originalRecords = records();
    JsonNode history = versions(saved);
    ((ObjectNode) configuration.path("canvas")).put("width", 1500);
    ObjectNode changed = fixed.deepCopy().put("title", "不应保存的名称");
    ArrayNode failedSteps = json.createArrayNode().add(changed);
    postJson(base + "/sops/save", edit(saved, failedSteps)
        .put("boardSettings", json.writeValueAsString(configuration)), 400);
    assertEquals(saved, stored(saved));
    assertEquals(history, versions(saved));
    assertEquals(originalRecords, records());

    ArrayNode repositioned = original.deepCopy();
    ((ObjectNode) repositioned.get(0)).set("frame", frame(1200, 300, 164, 164));
    JsonNode smaller = postJson(base + "/sops/save", edit(saved, repositioned)
        .put("boardSettings", json.writeValueAsString(configuration)), 200);
    assertEquals(repositioned, json.readTree(stored(smaller).path("draft").asText()));
    assertEquals(configuration, json.readTree(smaller.path("boardSettings").asText()));
    assertEquals(originalRecords, records());
    assertEquals(history.get(0), versions(smaller).get(1));
  }

  @Test
  void defaultCanvasAcceptsMinimumFramesWithTinyEdgeToleranceAndRejectsInvalidFramesAtomically()
      throws Exception {
    ObjectNode work = module("minimum");
    work.set("frame", frame(788.0000005, 788.0000005, 32, 32));
    ArrayNode original = json.createArrayNode().add(work);
    JsonNode saved = postJson(base + "/sops/save", body(original), 200);
    JsonNode originalRecords = records();
    JsonNode history = versions(saved);
    List<JsonNode> invalid = new ArrayList<>(List.of(json.nullNode(), json.createArrayNode(),
        json.getNodeFactory().textNode("frame"), json.createObjectNode()));
    for (String key : List.of("x", "y", "width", "height")) {
      ObjectNode missing = frame(0, 0, 32, 32);
      missing.remove(key);
      invalid.add(missing);
      for (JsonNode value : List.of(json.getNodeFactory().textNode("32"),
          json.getNodeFactory().booleanNode(true), json.nullNode(),
          json.getNodeFactory().numberNode(Double.NaN))) {
        ObjectNode invalidField = frame(0, 0, 32, 32);
        invalidField.set(key, value);
        invalid.add(invalidField);
      }
    }
    for (double[] values : List.of(new double[] {-0.001, 0, 32, 32},
        new double[] {0, -0.001, 32, 32}, new double[] {0, 0, 31.99, 32},
        new double[] {0, 0, 32, 31.99}, new double[] {0, 0, 2400.1, 32},
        new double[] {0, 0, 32, 2400.1}, new double[] {788.00001, 0, 32, 32},
        new double[] {0, 788.00001, 32, 32}, new double[] {1e100, 0, 32, 32}))
      invalid.add(frame(values[0], values[1], values[2], values[3]));
    for (JsonNode badFrame : invalid) {
      ObjectNode invalidWork = module("minimum").put("title", "不应保存的新名称");
      invalidWork.set("frame", badFrame);
      ArrayNode steps = json.createArrayNode().add(invalidWork);
      postJson(base + "/sops/save", edit(saved, steps), 400);
      postJson(base + "/sops/save", body(steps), 400);
    }
    assertEquals(saved, stored(saved));
    assertEquals(1, request(get(base + "/sops"), 200).size());
    assertEquals(history, versions(saved));
    assertEquals(originalRecords, records());
  }

  @Test
  void invalidReferenceCanvasesAreRejectedWithoutChangingSavedPixelsOrHistory() throws Exception {
    ObjectNode work = module("far-edge");
    work.set("frame", frame(2200, 900, 164, 164));
    ArrayNode steps = json.createArrayNode().add(work);
    ObjectNode configuration = settings(2400, 1200);
    configuration.putObject("referenceCanvas").put("width", 320).put("height", 2400);
    JsonNode saved = postJson(base + "/sops/save", body(steps)
        .put("boardSettings", json.writeValueAsString(configuration)), 200);
    JsonNode originalRecords = records();
    JsonNode history = versions(saved);
    List<JsonNode> invalid = List.of(json.nullNode(), json.createObjectNode(),
        json.createObjectNode().put("width", 820), json.createObjectNode().put("height", 820),
        json.createObjectNode().put("width", 319).put("height", 820),
        json.createObjectNode().put("width", 820).put("height", 2401),
        json.createObjectNode().put("width", 820.5).put("height", 820),
        json.createObjectNode().put("width", "820").put("height", 820));
    for (JsonNode reference : invalid) {
      ObjectNode settings = configuration.deepCopy();
      settings.set("referenceCanvas", reference);
      String encoded = json.writeValueAsString(settings);
      postJson(base + "/sops/save", edit(saved, steps).put("boardSettings", encoded), 400);
      postJson(base + "/sops/save", body(steps).put("boardSettings", encoded), 400);
    }
    assertEquals(saved, stored(saved));
    assertEquals(history, versions(saved));
    assertEquals(originalRecords, records());
    assertEquals(1, request(get(base + "/sops"), 200).size());
  }
}
