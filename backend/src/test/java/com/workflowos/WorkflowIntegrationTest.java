package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.*;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:test;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    })
@AutoConfigureMockMvc
class WorkflowIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  MockHttpSession session = new MockHttpSession();

  JsonNode send(String path, String body, int status) throws Exception {
    return request(post(path).content(body), status);
  }

  JsonNode request(MockHttpServletRequestBuilder b, int status) throws Exception {
    var result =
        mvc.perform(b.session(session).with(csrf()).contentType("application/json")).andReturn();
    assertEquals(
        status, result.getResponse().getStatus(), result.getResponse().getContentAsString());
    String s = result.getResponse().getContentAsString();
    return s.isEmpty() ? json.nullNode() : json.readTree(s);
  }

  String org() throws Exception {
    send(
        "/api/auth/register",
        "{\"email\":\""
            + java.util.UUID.randomUUID()
            + "@test.com\",\"password\":\"securepass123\",\"displayName\":\"测试\"}",
        200);
    return send("/api/organizations", "{\"name\":\"测试组织\"}", 200).path("id").asText();
  }

  @Test
  void tenantIsolationCsrfAndDailyExecution() throws Exception {
    String org = org(), base = "/api/orgs/" + org;
    String loc =
        send(base + "/locations", "{\"name\":\"测试地点\",\"timezone\":\"Asia/Tokyo\"}", 200)
            .path("id")
            .asText();
    send(base + "/demo", "{\"locationId\":\"" + loc + "\"}", 200);
    String payload =
        "{\"locationId\":\""
            + loc
            + "\",\"date\":\"2026-10-25\",\"variables\":{\"expected_guests\":100}}";
    var generated = send(base + "/plans/generate", payload, 200);
    assertEquals(8, generated.path("tasks").size());
    String plan = generated.path("plan").path("id").asText();
    assertEquals(8, send(base + "/plans/generate", payload, 200).path("tasks").size());
    JsonNode prep = null;
    for (JsonNode t : generated.path("tasks")) if (t.path("unit").asText().equals("kg")) prep = t;
    assertNotNull(prep);
    assertEquals(16.5, prep.path("plannedQuantity").asDouble());
    String id = prep.path("id").asText();
    send(
        base + "/tasks/" + id + "/execute",
        "{\"action\":\"COMPLETE\",\"requestKey\":\"invalid-complete-00001\",\"actualQuantity\":16.5}",
        400);
    String start = "{\"action\":\"START\",\"requestKey\":\"start-idempotent-00001\"}";
    send(base + "/tasks/" + id + "/execute", start, 200);
    send(base + "/tasks/" + id + "/execute", start, 200);
    send(
        base + "/tasks/" + id + "/execute",
        "{\"action\":\"COMPLETE\",\"requestKey\":\"missing-step-000001\",\"actualQuantity\":16.5}",
        400);
    send(
        base + "/tasks/" + id + "/execute",
        "{\"action\":\"COMPLETE\",\"requestKey\":\"complete-task-000001\",\"confirmations\":[1,2],\"actualQuantity\":16.5}",
        200);
    var recalc =
        send(
            base + "/plans/" + plan + "/recalculate",
            "{\"variables\":{\"expected_guests\":200},\"apply\":false}",
            200);
    assertTrue(recalc.path("diffs").toString().contains("PROTECTED"));
    send(
        base + "/plans/" + plan + "/recalculate",
        "{\"variables\":{\"expected_guests\":200},\"apply\":true,\"expectedRevision\":"
            + recalc.path("revision").asLong()
            + ",\"previewToken\":\""
            + recalc.path("previewToken").asText()
            + "\"}",
        200);
    var detail = request(get(base + "/tasks/" + id), 200);
    assertEquals(16.5, detail.path("task").path("plannedQuantity").asDouble());
    assertEquals(2, detail.path("logs").size());
    var other = new MockHttpSession();
    var old = session;
    session = other;
    org();
    request(get(base + "/tasks/" + id), 403);
    session = old;
    mvc.perform(
            post(base + "/locations")
                .session(session)
                .contentType("application/json")
                .content("{\"name\":\"bad\"}"))
        .andExpect(status().isForbidden());
  }

  @Test
  void invalidRuleRollsBackWholePlan() throws Exception {
    String org = org(), base = "/api/orgs/" + org;
    String loc = send(base + "/locations", "{\"name\":\"A\"}", 200).path("id").asText();
    send(base + "/demo", "{\"locationId\":\"" + loc + "\"}", 200);
    send(
        base + "/plans/generate",
        "{\"locationId\":\"" + loc + "\",\"date\":\"2026-10-25\",\"variables\":{}}",
        400);
    var p = request(get(base + "/plans?locationId=" + loc + "&date=2026-10-25"), 200);
    assertTrue(p.path("plan").isNull());
    assertEquals(0, p.path("tasks").size());
  }

  JsonNode object(String path, Object body, int status) throws Exception {
    return send(path, json.writeValueAsString(body), status);
  }

  @Test
  void frozenSopAndLockedQuantitySurviveChanges() throws Exception {
    String base = "/api/orgs/" + org();
    String loc =
        object(base + "/locations", java.util.Map.of("name", "快照测试"), 200).path("id").asText();
    object(base + "/demo", java.util.Map.of("locationId", loc), 200);
    var result =
        object(
            base + "/plans/generate",
            java.util.Map.of(
                "locationId",
                loc,
                "date",
                "2026-10-25",
                "variables",
                java.util.Map.of("expected_guests", 100)),
            200);
    JsonNode prep = null;
    for (JsonNode t : result.path("tasks")) if (t.path("unit").asText().equals("kg")) prep = t;
    String taskId = prep.path("id").asText(), planId = result.path("plan").path("id").asText();
    object(
        base + "/tasks/" + taskId + "/execute",
        java.util.Map.of(
            "action",
            "QUANTITY",
            "requestKey",
            java.util.UUID.randomUUID().toString(),
            "plannedQuantity",
            12,
            "note",
            "现场确认调整"),
        200);
    var sops = request(get(base + "/sops"), 200);
    String sopId = "";
    for (JsonNode sop : sops)
      if (sop.path("currentVersionId").asText().equals(prep.path("sopVersionId").asText()))
        sopId = sop.path("id").asText();
    var newSop =
        java.util.Map.of(
            "title",
            "新标准",
            "category",
            "日常",
            "steps",
            java.util.List.of(java.util.Map.of("title", "新步骤")));
    request(put(base + "/sops/" + sopId).content(json.writeValueAsString(newSop)), 200);
    send(base + "/sops/" + sopId + "/publish", "{}", 200);
    var detail = request(get(base + "/tasks/" + taskId), 200);
    assertEquals(1, detail.path("sop").path("versionNumber").asInt());
    assertNotEquals("新标准", detail.path("sop").path("title").asText());
    var preview =
        object(
            base + "/plans/" + planId + "/recalculate",
            java.util.Map.of("variables", java.util.Map.of("expected_guests", 200), "apply", false),
            200);
    assertTrue(preview.path("diffs").toString().contains("LOCKED"));
    object(
        base + "/tasks/" + taskId + "/execute",
        java.util.Map.of(
            "action",
            "QUANTITY",
            "requestKey",
            java.util.UUID.randomUUID().toString(),
            "plannedQuantity",
            13,
            "note",
            "预览后再次调整"),
        200);
    object(
        base + "/plans/" + planId + "/recalculate",
        java.util.Map.of(
            "variables",
            java.util.Map.of("expected_guests", 200),
            "apply",
            true,
            "expectedRevision",
            preview.path("revision").asLong(),
            "previewToken",
            preview.path("previewToken").asText()),
        400);
    object(
        base + "/tasks/" + taskId + "/execute",
        java.util.Map.of(
            "action",
            "QUANTITY",
            "requestKey",
            java.util.UUID.randomUUID().toString(),
            "plannedQuantity",
            12,
            "note",
            "确认最终数量"),
        200);
    preview =
        object(
            base + "/plans/" + planId + "/recalculate",
            java.util.Map.of("variables", java.util.Map.of("expected_guests", 200), "apply", false),
            200);

    object(
        base + "/plans/" + planId + "/recalculate",
        java.util.Map.of(
            "variables",
            java.util.Map.of("expected_guests", 200),
            "apply",
            true,
            "expectedRevision",
            preview.path("revision").asLong(),
            "previewToken",
            preview.path("previewToken").asText()),
        200);
    detail = request(get(base + "/tasks/" + taskId), 200);
    assertEquals(12, detail.path("task").path("plannedQuantity").asDouble());
    assertEquals(16.5, detail.path("task").path("suggestedQuantity").asDouble());
  }

  @Test
  void employeeCannotManageAndInvitationsCannotBeReused() throws Exception {
    String org = org(), base = "/api/orgs/" + org;
    String email = java.util.UUID.randomUUID() + "@example.com";
    var invitation =
        object(base + "/invitations", java.util.Map.of("email", email, "role", "EMPLOYEE"), 200);
    session = new MockHttpSession();
    object(
        "/api/auth/register",
        java.util.Map.of("email", email, "password", "SecurePass123!", "displayName", "员工"),
        200);
    object(
        base + "/invitations/accept",
        java.util.Map.of("token", invitation.path("token").asText()),
        200);
    object(
        base + "/invitations/accept",
        java.util.Map.of("token", invitation.path("token").asText()),
        400);
    request(get(base + "/locations"), 200);
    object(base + "/locations", java.util.Map.of("name", "不能创建"), 403);
    object(base + "/sops", java.util.Map.of("title", "不能创建", "steps", java.util.List.of()), 403);
    request(get(base + "/audit"), 403);
  }
}
