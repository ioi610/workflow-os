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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(
    properties = {
      "spring.datasource.url=jdbc:h2:mem:sop-delete;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
    })
@AutoConfigureMockMvc
class SopDeleteIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate jdbc;
  MockHttpSession session;
  String base;
  UUID org;
  UUID user;

  @BeforeEach
  void workspace() throws Exception {
    session = new MockHttpSession();
    postJson(
        "/api/auth/register",
        Map.of(
            "email", UUID.randomUUID() + "@test.com",
            "password", "SecurePass123!",
            "displayName", "删除测试"),
        200);
    user = (UUID) session.getAttribute("userId");
    org = UUID.fromString(postJson("/api/organizations", Map.of("name", "工作模板"), 200)
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

  ObjectNode body(String title) {
    ObjectNode body = json.createObjectNode().put("title", title).put("category", "日常");
    var steps = body.putArray("steps");
    steps.addObject().put("kind", "MODULE").put("id", "module-a").put("title", "准备材料");
    steps.addObject().put("kind", "DETAIL").put("title", "准备材料")
        .putArray("items").addObject().put("text", "自己编写的详细做法");
    return body;
  }

  JsonNode saved(String title) throws Exception {
    return postJson(base + "/sops/save", body(title), 200);
  }

  String path(JsonNode sop) {
    return base + "/sops/" + sop.path("id").asText();
  }

  JsonNode remove(JsonNode sop, int expected) throws Exception {
    return request(delete(path(sop)).content(json.writeValueAsString(
        Map.of("expectedRevision", sop.path("revision").asLong()))), expected);
  }

  int count(String table, String column, UUID id) {
    return jdbc.queryForObject("select count(*) from " + table + " where " + column + "=?",
        Integer.class, id);
  }

  @Test
  void deletingPublishedWorkflowRemovesItsRecordsAndHistoryWhileOtherWorkflowsStayIntact()
      throws Exception {
    JsonNode first = saved("待删除工作模板");
    ObjectNode changed = body("待删除工作模板的新名称")
        .put("id", first.path("id").asText())
        .put("expectedRevision", first.path("revision").asLong());
    JsonNode latest = postJson(base + "/sops/save", changed, 200);
    ObjectNode otherBody = body("另一个工作模板");
    JsonNode other = postJson(base + "/sops/save", otherBody, 200);
    UUID deletedId = UUID.fromString(latest.path("id").asText());
    assertEquals(2, count("sop_versions", "sop_id", deletedId));
    assertEquals(1, count("work_items", "workflow_id", deletedId));
    JsonNode otherVersions = request(get(path(other) + "/versions"), 200);

    remove(latest, 204);

    assertEquals(0, count("sops", "id", deletedId));
    assertEquals(0, count("sop_versions", "sop_id", deletedId));
    assertEquals(0, count("work_items", "workflow_id", deletedId));
    assertEquals(1, jdbc.queryForObject(
        "select count(*) from audit_logs where resource_id=? and action='SOP_DELETE'",
        Integer.class, deletedId));
    JsonNode remaining = request(get(base + "/sops"), 200);
    assertEquals(1, remaining.size());
    assertEquals(other, remaining.get(0));
    assertEquals(otherVersions, request(get(path(other) + "/versions"), 200));
    assertEquals(1, request(get(base + "/work-items"), 200).size());
    request(get(path(latest) + "/versions"), 404);
    remove(latest, 404);
  }

  @Test
  void unpublishedEmptyWorkflowCanAlsoBeDeleted() throws Exception {
    ObjectNode body = body("空白草稿");
    body.putArray("steps");
    JsonNode draft = postJson(base + "/sops", body, 200);
    assertTrue(draft.path("currentVersionId").isNull());
    remove(draft, 204);
    assertEquals(0, request(get(base + "/sops"), 200).size());
  }

  @Test
  void staleMissingAndCrossWorkspaceDeletesLeaveWorkflowAndHistoryUntouched() throws Exception {
    JsonNode first = saved("第一版");
    JsonNode current = postJson(base + "/sops/save", body("新版本")
        .put("id", first.path("id").asText())
        .put("expectedRevision", first.path("revision").asLong()), 200);
    remove(first, 409);
    request(delete(path(current)).content("{}"), 400);
    String otherBase = "/api/orgs/" + postJson("/api/organizations", Map.of("name", "其他工作区"), 200)
        .path("id").asText();
    request(delete(otherBase + "/sops/" + current.path("id").asText())
        .content(json.writeValueAsString(Map.of("expectedRevision", current.path("revision").asLong()))), 404);
    assertEquals(current, request(get(base + "/sops"), 200).get(0));
    assertEquals(2, request(get(path(current) + "/versions"), 200).size());
    assertEquals(1, request(get(base + "/work-items"), 200).size());
  }

  @Test
  void deletionRequiresCsrfMembershipAndManagerOrOwnerRole() throws Exception {
    JsonNode sop = saved("权限测试");
    String payload = json.writeValueAsString(Map.of("expectedRevision", sop.path("revision").asLong()));
    assertEquals(403, mvc.perform(delete(path(sop)).session(session)
        .contentType("application/json").content(payload)).andReturn().getResponse().getStatus());
    jdbc.update("update members set role='EMPLOYEE' where organization_id=? and user_id=?", org, user);
    remove(sop, 403);
    jdbc.update("update members set status='INACTIVE' where organization_id=? and user_id=?", org, user);
    remove(sop, 403);
    MockHttpSession ownerSession = session;
    session = new MockHttpSession();
    remove(sop, 401);
    session = ownerSession;
    jdbc.update("update members set role='MANAGER',status='ACTIVE' where organization_id=? and user_id=?", org, user);
    remove(sop, 204);
    assertEquals(0, count("sops", "id", UUID.fromString(sop.path("id").asText())));
  }

  @Test
  void legacyTemplateAndExecutedTaskReferencesReturnExplicitConflictWithoutPartialDeletion()
      throws Exception {
    JsonNode sop = saved("保留历史任务");
    UUID workflow = UUID.fromString(sop.path("id").asText());
    UUID template = UUID.randomUUID();
    jdbc.update("insert into task_templates(id,created_at,revision,organization_id,name,"
            + "duration_minutes,active,sop_id) values(?,current_timestamp,0,?,'旧版模板',30,true,?)",
        template, org, workflow);
    assertEquals("还有旧工作在使用这个流程，暂时不能删除", remove(sop, 409).path("message").asText());
    jdbc.update("delete from task_templates where id=?", template);
    UUID task = UUID.randomUUID();
    jdbc.update("insert into daily_tasks(id,created_at,revision,organization_id,title,"
            + "quantity_locked,sop_version_id) values(?,current_timestamp,0,?,'已有执行记录',false,?)",
        task, org, UUID.fromString(sop.path("currentVersionId").asText()));
    assertEquals("还有旧工作在使用这个流程，暂时不能删除", remove(sop, 409).path("message").asText());
    assertEquals(sop, request(get(base + "/sops"), 200).get(0));
    assertEquals(1, count("sop_versions", "sop_id", workflow));
    assertEquals(1, count("work_items", "workflow_id", workflow));
    assertEquals(1, count("daily_tasks", "id", task));
    jdbc.update("delete from daily_tasks where id=?", task);
    remove(sop, 204);
  }
}
