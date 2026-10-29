package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;

import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class BoardSettingsMigrationTest {
  @Test
  void upgradingAnExistingWorkflowKeepsItsContentRevisionAndPublishedHistory() {
    String url = "jdbc:h2:mem:board-settings-upgrade-" + UUID.randomUUID()
        + ";MODE=PostgreSQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    Flyway.configure().dataSource(url, "sa", "").target("4").load().migrate();
    JdbcTemplate jdbc = new JdbcTemplate(new DriverManagerDataSource(url, "sa", ""));
    UUID org = UUID.randomUUID(), workflow = UUID.randomUUID(), version = UUID.randomUUID();
    String steps = "[{\"title\":\"原有工作\",\"description\":\"保留原有做法\"}]";
    jdbc.update("insert into organizations(id,created_at,revision,name) values(?,current_timestamp,0,?)",
        org, "原有工作区");
    jdbc.update("insert into sops(id,created_at,revision,organization_id,title,category,status,draft)"
            + " values(?,current_timestamp,7,?,?,'原有分类','PUBLISHED',?)",
        workflow, org, "原有流程", steps);
    jdbc.update("insert into sop_versions(id,created_at,revision,organization_id,sop_id,version_number,"
            + "title,steps) values(?,current_timestamp,0,?,?,3,?,?)",
        version, org, workflow, "原有流程", steps);
    jdbc.update("update sops set current_version_id=? where id=?", version, workflow);

    Flyway.configure().dataSource(url, "sa", "").load().migrate();

    var stored = jdbc.queryForMap("select * from sops where id=?", workflow);
    assertEquals("原有流程", stored.get("title"));
    assertEquals("原有分类", stored.get("category"));
    assertEquals(7L, stored.get("revision"));
    assertEquals(version, stored.get("current_version_id"));
    assertEquals(steps, stored.get("draft"));
    assertNull(stored.get("board_settings"));
    var history = jdbc.queryForMap("select * from sop_versions where id=?", version);
    assertEquals(workflow, history.get("sop_id"));
    assertEquals(3, history.get("version_number"));
    assertEquals(steps, history.get("steps"));
    assertNull(history.get("board_settings"));
  }
}
