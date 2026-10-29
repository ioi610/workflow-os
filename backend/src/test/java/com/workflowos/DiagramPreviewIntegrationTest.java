package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.*;
import java.time.Clock;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:diagram-preview;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
})
@AutoConfigureMockMvc
@Import(DiagramPreviewIntegrationTest.FakeProvider.class)
class DiagramPreviewIntegrationTest {
  @TestConfiguration
  static class FakeProvider {
    @Bean AtomicInteger diagramCalls() { return new AtomicInteger(); }
    @Bean @Primary DiagramPreviewService fakeDiagrams(ObjectMapper json, AtomicInteger diagramCalls) {
      return new DiagramPreviewService(json, true, "unit-test-key", "gpt-5.4-mini", request -> {
        diagramCalls.incrementAndGet();
        String diagram = """
            {"title":"清洁流程","nodes":[{"id":"clean","name":"清洁设备","details":["断电后清洁设备。"],"nextIds":[]}]}
            """;
        var reply = json.createObjectNode().put("status", "completed");
        reply.putArray("output").addObject().put("type", "message")
            .putArray("content").addObject().put("type", "output_text").put("text", diagram);
        return new DiagramPreviewService.ProviderReply(200, reply.toString());
      }, Clock.systemUTC());
    }
  }

  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate db;
  @Autowired AtomicInteger diagramCalls;
  MockHttpSession session;
  String base;

  @BeforeEach
  void workspace() throws Exception {
    session = new MockHttpSession();
    register(UUID.randomUUID() + "@test.com");
    base = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "文字生成测试"), 200).path("id").asText();
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

  void register(String email) throws Exception {
    postJson("/api/auth/register", Map.of("email", email, "password", "SecurePass123!", "displayName", "测试成员"), 200);
  }

  Map<String, Long> counts() {
    Map<String, Long> result = new TreeMap<>();
    for (String table : List.of("sops", "sop_versions", "work_items", "audit_logs")) {
      result.put(table, db.queryForObject("select count(*) from " + table, Long.class));
    }
    return result;
  }

  @Test
  void previewReturnsStructureWithoutCreatingWorkflowsWorkRecordsVersionsOrAudit() throws Exception {
    // Keep a real saved flow in this isolated in-memory database to detect accidental overwrites.
    JsonNode saved = postJson(base + "/sops/save", Map.of("title", "现有流程", "steps",
        List.of(Map.of("kind", "MODULE", "id", "old-work", "title", "现有工作"))), 200);
    JsonNode workflows = request(get(base + "/sops"), 200);
    JsonNode records = request(get(base + "/work-items"), 200);
    Map<String, Long> before = counts();
    assertTrue(request(get(base + "/diagram-preview"), 200).path("available").asBoolean());
    JsonNode preview = postJson(base + "/diagram-preview", Map.of("text", "断电后清洁设备。"), 200);
    assertEquals("清洁流程", preview.path("title").asText());
    assertEquals("断电后清洁设备。", preview.path("nodes").get(0).path("details").get(0).asText());
    assertEquals(before, counts());
    assertEquals(workflows, request(get(base + "/sops"), 200));
    assertEquals(records, request(get(base + "/work-items"), 200));
    assertEquals(saved.path("id"), workflows.get(0).path("id"));
  }

  @Test
  void onlyEditableMembersCanCheckAvailabilityOrInvokeTheProvider() throws Exception {
    int before = diagramCalls.get();
    MockHttpSession owner = session;
    postJson("/api/orgs/" + UUID.randomUUID() + "/diagram-preview", Map.of("text", "断电后清洁设备。"), 403);
    String employeeEmail = UUID.randomUUID() + "@test.com";
    JsonNode invitation = postJson(base + "/invitations", Map.of("email", employeeEmail, "role", "EMPLOYEE"), 200);
    session = new MockHttpSession();
    register(employeeEmail);
    postJson(base + "/invitations/accept", Map.of("token", invitation.path("token").asText()), 200);
    request(get(base + "/diagram-preview"), 403);
    postJson(base + "/diagram-preview", Map.of("text", "断电后清洁设备。"), 403);
    session = new MockHttpSession();
    request(get(base + "/diagram-preview"), 401);
    postJson(base + "/diagram-preview", Map.of("text", "断电后清洁设备。"), 401);
    session = owner;
    assertEquals(before, diagramCalls.get());
  }

  @Test
  void csrfAndTextValidationProtectThePaidAction() throws Exception {
    int before = diagramCalls.get();
    var noCsrf = mvc.perform(post(base + "/diagram-preview").session(session).contentType("application/json")
        .content("{\"text\":\"断电后清洁设备。\"}")).andReturn().getResponse();
    assertEquals(403, noCsrf.getStatus());
    for (Object body : List.of(Map.of(), Map.of("text", "  "), Map.of("text", "字".repeat(16001))))
      postJson(base + "/diagram-preview", body, 400);
    assertEquals(before, diagramCalls.get());
  }
}
