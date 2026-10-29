package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.csrf;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:h2:mem:personal-disabled;MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1"
})
@AutoConfigureMockMvc
class PersonalModeDisabledIntegrationTest {
  @Autowired MockMvc mvc;
  @Autowired ObjectMapper json;
  @Autowired JdbcTemplate jdbc;

  @Test
  void personalModeIsOffByDefaultAndCannotCreateAnAccountOrBypassAuthentication() throws Exception {
    var mode = mvc.perform(get("/api/mode")).andReturn().getResponse();
    assertEquals(200, mode.getStatus());
    assertFalse(json.readTree(mode.getContentAsString()).path("personalMode").asBoolean());
    assertEquals(404, mvc.perform(post("/api/personal/bootstrap").with(csrf())
        .contentType("application/json").content("{}"))
        .andReturn().getResponse().getStatus());
    assertEquals(401, mvc.perform(get("/api/auth/me")).andReturn().getResponse().getStatus());
    assertEquals(0L, jdbc.queryForObject("select count(*) from accounts", Long.class));
    assertNull(jdbc.queryForObject("select owner_user_id from personal_installation where id=1", java.util.UUID.class));
  }
}
