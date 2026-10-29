package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:diagram-disabled;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1",
    "workflow.diagram.api-key=unit-test-key"
})
@AutoConfigureMockMvc
class DiagramPreviewDisabledIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate db;
  @Autowired Environment environment;
  @Autowired DiagramPreviewService diagrams;
  final MockHttpSession session = new MockHttpSession();

  JsonNode request(MockHttpServletRequestBuilder builder, int expected) throws Exception {
    var response = mvc.perform(builder.session(session).with(csrf()).contentType("application/json"))
        .andReturn().getResponse();
    assertEquals(expected, response.getStatus(), response.getContentAsString());
    return json.readTree(response.getContentAsString());
  }

  JsonNode postJson(String path, Object body, int expected) throws Exception {
    return request(post(path).content(json.writeValueAsString(body)), expected);
  }

  Map<String, Long> counts() {
    Map<String, Long> result = new TreeMap<>();
    for (String table : List.of("sops", "sop_versions", "work_items", "audit_logs"))
      result.put(table, db.queryForObject("select count(*) from " + table, Long.class));
    return result;
  }

  @Test
  void freeVersionDefaultsToDisabledWithAnExistingKeyAndLeavesSavedWorkUntouched() throws Exception {
    // Exercise the production Spring bean and default YAML flag, rather than a fake provider bean.
    assertFalse(environment.getProperty("workflow.diagram.enabled", Boolean.class, true));
    assertFalse(diagrams.available());
    postJson("/api/auth/register", Map.of("email", UUID.randomUUID() + "@test.com",
        "password", "SecurePass123!", "displayName", "测试成员"), 200);
    String base = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "免费生成测试"), 200)
        .path("id").asText();
    postJson(base + "/sops/save", Map.of("title", "现有流程", "steps",
        List.of(Map.of("kind", "MODULE", "id", "existing-work", "title", "现有工作"))), 200);
    JsonNode workflows = request(get(base + "/sops"), 200);
    JsonNode records = request(get(base + "/work-items"), 200);
    Map<String, Long> before = counts();

    assertFalse(request(get(base + "/diagram-preview"), 200).path("available").asBoolean(true));
    JsonNode error = postJson(base + "/diagram-preview", Map.of("text", "断电后清洁设备。"), 503);
    assertTrue(error.toString().contains("当前使用本机免费生成"));
    assertFalse(error.toString().contains("unit-test-key"));
    assertEquals(before, counts());
    assertEquals(workflows, request(get(base + "/sops"), 200));
    assertEquals(records, request(get(base + "/work-items"), 200));
  }
}
