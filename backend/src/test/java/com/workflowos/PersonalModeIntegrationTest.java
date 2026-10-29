package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpSession;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:personal-mode;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
})
@ActiveProfiles("local")
@AutoConfigureMockMvc
class PersonalModeIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate jdbc;

  @BeforeEach
  void unpinInstallation() {
    jdbc.update("update personal_installation set owner_user_id=null, default_organization_id=null, revision=revision+1");
  }

  JsonNode request(MockHttpServletRequestBuilder builder, MockHttpSession session, int status)
      throws Exception {
    var response = mvc.perform(builder.session(session).with(csrf()).contentType("application/json"))
        .andReturn().getResponse();
    assertEquals(status, response.getStatus(), response.getContentAsString());
    return json.readTree(response.getContentAsString());
  }

  JsonNode postJson(String path, Object body, MockHttpSession session) throws Exception {
    return request(post(path).content(json.writeValueAsString(body)), session, 200);
  }

  JsonNode bootstrap(MockHttpSession session, String organization) throws Exception {
    return postJson("/api/personal/bootstrap",
        organization == null ? Map.of() : Map.of("organizationId", organization), session);
  }

  JsonNode register(MockHttpSession session) throws Exception {
    return postJson("/api/auth/register", Map.of(
        "email", UUID.randomUUID() + "@test.com",
        "password", "SecurePass123!",
        "displayName", "原有作者"), session);
  }

  String organization(MockHttpSession session, String name) throws Exception {
    return postJson("/api/organizations", Map.of("name", name), session).path("id").asText();
  }

  JsonNode saveWorkflow(MockHttpSession session, String organization) throws Exception {
    return postJson("/api/orgs/" + organization + "/sops/save", Map.of(
        "title", "清洁流程", "category", "手册",
        "steps", List.of(
            Map.of("kind", "MODULE", "id", "module", "title", "清洁设备"),
            Map.of("kind", "DETAIL", "id", "detail", "title", "清洁设备", "items",
                List.of(Map.of("id", "step", "text", "先断电，再擦拭设备。"))))), session);
  }

  long count(String table) {
    return jdbc.queryForObject("select count(*) from " + table, Long.class);
  }

  @Test
  void firstVisitCreatesOnePrivateWorkspaceAndFreshSessionsReopenSavedWorkflow() throws Exception {
    long accounts = count("accounts"), organizations = count("organizations"), members = count("members");
    MockHttpSession first = new MockHttpSession();
    assertTrue(request(get("/api/mode"), first, 200).path("personalMode").asBoolean());
    // A body is optional, so a fresh installation needs no setup form.
    JsonNode initial = request(post("/api/personal/bootstrap"), first, 200);
    String org = initial.path("defaultOrganizationId").asText();
    String owner = initial.path("user").path("id").asText();
    assertTrue(initial.path("personalMode").asBoolean());
    assertEquals("我的工作手册", initial.path("organizations").get(0).path("name").asText());
    assertEquals("OWNER", initial.path("memberships").get(0).path("role").asText());
    assertFalse(initial.path("user").has("passwordHash"));
    JsonNode workflow = saveWorkflow(first, org);
    assertEquals(owner, request(get("/api/auth/me"), first, 200).path("user").path("id").asText());
    assertEquals(accounts + 1, count("accounts"));
    assertEquals(organizations + 1, count("organizations"));
    assertEquals(members + 1, count("members"));

    request(post("/api/auth/logout"), first, 200);
    MockHttpSession reopened = new MockHttpSession();
    JsonNode again = bootstrap(reopened, null);
    assertEquals(owner, again.path("user").path("id").asText());
    assertEquals(org, again.path("defaultOrganizationId").asText());
    assertEquals(workflow, request(get("/api/orgs/" + org + "/sops"), reopened, 200).get(0));
    assertEquals(accounts + 1, count("accounts"));
    assertEquals(organizations + 1, count("organizations"));
    assertEquals(members + 1, count("members"));
  }

  @Test
  void hintedExistingWorkspacePreservesItsOwnerAndNeverRetargetsOrGrantsOtherMemberships()
      throws Exception {
    MockHttpSession original = new MockHttpSession(), other = new MockHttpSession();
    JsonNode originalOwner = register(original);
    String org = organization(original, "原有工作手册");
    JsonNode workflow = saveWorkflow(original, org);
    register(other);
    String otherOrg = organization(other, "另一个账号的手册");
    long accounts = count("accounts"), organizations = count("organizations"), members = count("members");

    MockHttpSession anonymous = new MockHttpSession();
    JsonNode installed = bootstrap(anonymous, org);
    assertEquals(originalOwner, installed.path("user"));
    assertEquals(org, installed.path("defaultOrganizationId").asText());
    assertEquals(workflow, request(get("/api/orgs/" + org + "/sops"), anonymous, 200).get(0));
    request(get("/api/orgs/" + otherOrg + "/sops"), anonymous, 403);

    JsonNode retarget = bootstrap(new MockHttpSession(), otherOrg);
    assertEquals(installed, retarget);
    // Even a different authenticated user cannot replace the permanently pinned identity.
    assertEquals(installed, bootstrap(other, otherOrg));
    request(get("/api/orgs/" + otherOrg + "/sops"), other, 403);
    assertEquals(accounts, count("accounts"));
    assertEquals(organizations, count("organizations"));
    assertEquals(members, count("members"));
    assertEquals(1, installed.path("memberships").size());
  }

  @Test
  void currentSessionTakesPriorityOverAHintToAnotherOwnersWorkspace() throws Exception {
    MockHttpSession original = new MockHttpSession(), other = new MockHttpSession();
    JsonNode owner = register(original);
    String org = organization(original, "我自己的手册");
    register(other);
    String otherOrg = organization(other, "其他手册");
    JsonNode installed = bootstrap(original, otherOrg);
    assertEquals(owner, installed.path("user"));
    assertEquals(org, installed.path("defaultOrganizationId").asText());
    request(get("/api/orgs/" + otherOrg + "/sops"), original, 403);
  }

  @Test
  void existingAccountWithoutOrganizationGetsAnOwnedWorkspaceWithoutAnotherAccount() throws Exception {
    MockHttpSession session = new MockHttpSession();
    JsonNode owner = register(session);
    long accounts = count("accounts"), organizations = count("organizations");
    JsonNode installed = bootstrap(session, UUID.randomUUID().toString());
    assertEquals(owner, installed.path("user"));
    assertEquals(accounts, count("accounts"));
    assertEquals(organizations + 1, count("organizations"));
    saveWorkflow(session, installed.path("defaultOrganizationId").asText());
  }

  @Test
  void bootstrapStillRequiresCsrfAndDoesNotImplicitlyAuthenticateOtherEndpoints() throws Exception {
    long accounts = count("accounts");
    MockHttpSession session = new MockHttpSession();
    assertEquals(403, mvc.perform(post("/api/personal/bootstrap").session(session)
        .contentType("application/json").content("{}")).andReturn().getResponse().getStatus());
    request(get("/api/auth/me"), session, 401);
    assertEquals(accounts, count("accounts"));
    assertNull(jdbc.queryForObject("select owner_user_id from personal_installation where id=1", UUID.class));
  }

  @Test
  void concurrentFirstVisitsCreateOnlyOneIdentityAndWorkspace() throws Exception {
    long accounts = count("accounts"), organizations = count("organizations"), members = count("members");
    CountDownLatch start = new CountDownLatch(1);
    List<Future<JsonNode>> visits = new ArrayList<>();
    try (ExecutorService pool = Executors.newFixedThreadPool(6)) {
      for (int i = 0; i < 6; i++) visits.add(pool.submit(() -> {
        start.await();
        return bootstrap(new MockHttpSession(), null);
      }));
      start.countDown();
      JsonNode installed = visits.get(0).get(20, TimeUnit.SECONDS);
      for (Future<JsonNode> visit : visits) assertEquals(installed, visit.get(20, TimeUnit.SECONDS));
    }
    assertEquals(accounts + 1, count("accounts"));
    assertEquals(organizations + 1, count("organizations"));
    assertEquals(members + 1, count("members"));
  }
}
