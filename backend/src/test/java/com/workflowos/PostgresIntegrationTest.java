package com.workflowos;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.*;

@Testcontainers(disabledWithoutDocker = true)
@SpringBootTest
class PostgresIntegrationTest {
  @Container static PostgreSQLContainer<?> db = new PostgreSQLContainer<>("postgres:16-alpine");

  @DynamicPropertySource
  static void datasource(DynamicPropertyRegistry p) {
    p.add("spring.datasource.url", db::getJdbcUrl);
    p.add("spring.datasource.username", db::getUsername);
    p.add("spring.datasource.password", db::getPassword);
  }

  @Test
  void migrationsAndHibernateSchemaValidate() {}
}
