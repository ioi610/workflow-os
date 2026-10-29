package com.workflowos;

import com.fasterxml.jackson.annotation.JsonIgnore;
import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.*;
import java.util.UUID;

public class Model {
  @MappedSuperclass
  public static class Base {
    @Id public UUID id = UUID.randomUUID();
    public Instant createdAt = Instant.now();
    @Version public long revision;
  }

  @MappedSuperclass
  public static class Tenant extends Base {
    @Column(nullable = false)
    public UUID organizationId;
  }

  @Entity(name = "Account")
  @Table(name = "accounts")
  public static class Account extends Base {
    @Column(nullable = false, unique = true)
    public String email;

    @JsonIgnore
    @Column(nullable = false)
    public String passwordHash;

    public String displayName;
  }

  @Entity(name = "PersonalInstallation")
  @Table(name = "personal_installation")
  public static class PersonalInstallation {
    @Id public Integer id;
    public UUID ownerUserId;
    public UUID defaultOrganizationId;
    @Version public long revision;
  }

  @Entity(name = "Organization")
  @Table(name = "organizations")
  public static class Organization extends Base {
    public String name;
  }

  @Entity(name = "Member")
  @Table(
      name = "members",
      uniqueConstraints = @UniqueConstraint(columnNames = {"organizationId", "userId"}))
  public static class Member extends Tenant {
    public UUID userId;
    public String role;
    public String status = "ACTIVE";
  }

  @Entity(name = "Invitation")
  @Table(name = "invitations")
  public static class Invitation extends Tenant {
    public String email;
    public String role;
    @JsonIgnore public String tokenHash;
    public Instant expiresAt;
    public boolean accepted;
  }

  @Entity(name = "Location")
  @Table(name = "locations")
  public static class Location extends Tenant {
    public String name;
    public String timezone = "Asia/Tokyo";
  }

  @Entity(name = "Sop")
  @Table(name = "sops")
  public static class Sop extends Tenant {
    public String title;
    public String category;
    public String status = "DRAFT";
    public UUID currentVersionId;

    @Column(columnDefinition = "text")
    public String draft = "[]";

    @Column(columnDefinition = "text")
    public String boardSettings;
  }

  @Entity(name = "SopVersion")
  @Table(
      name = "sop_versions",
      uniqueConstraints = @UniqueConstraint(columnNames = {"sopId", "versionNumber"}))
  public static class SopVersion extends Tenant {
    public UUID sopId;
    public int versionNumber;
    public String title;

    @Column(columnDefinition = "text")
    public String steps;

    @Column(columnDefinition = "text")
    public String boardSettings;

    public Instant publishedAt;
    public UUID publishedBy;
  }

  @Entity(name = "WorkItem")
  @Table(
      name = "work_items",
      uniqueConstraints = @UniqueConstraint(columnNames = {"workflowId", "moduleId"}))
  public static class WorkItem extends Tenant {
    @Column(nullable = false)
    public UUID workflowId;

    @Column(nullable = false)
    public String moduleId;

    @Column(nullable = false, columnDefinition = "text")
    public String name;

    @Column(nullable = false, columnDefinition = "text")
    public String notes = "";

    @Column(nullable = false)
    public Instant updatedAt = Instant.now();
  }

  @Entity(name = "Template")
  @Table(name = "task_templates")
  public static class Template extends Tenant {
    public UUID locationId;
    public String name;

    @Column(columnDefinition = "text")
    public String description = "";

    public String category = "日常工作";
    public String startTime = "08:00";
    public int durationMinutes = 30;
    public String priority = "NORMAL";
    public UUID sopId;
    public UUID assignedUserId;
    public boolean active = true;

    @Column(columnDefinition = "text")
    public String recurrence = "{\"type\":\"DAILY\"}";

    @Column(columnDefinition = "text")
    public String prerequisites = "[]";

    public BigDecimal quantity;
    public String unit = "";
  }

  @Entity(name = "Plan")
  @Table(
      name = "daily_plans",
      uniqueConstraints = @UniqueConstraint(columnNames = {"locationId", "businessDate"}))
  public static class Plan extends Tenant {
    public UUID locationId;
    public LocalDate businessDate;
    public String status = "DRAFT";

    @Column(columnDefinition = "text")
    public String variables = "{}";

    public Instant generatedAt;
  }

  @Entity(name = "Task")
  @Table(
      name = "daily_tasks",
      uniqueConstraints = @UniqueConstraint(columnNames = {"planId", "sourceKey"}))
  public static class Task extends Tenant {
    public UUID planId;
    public UUID templateId;
    public String sourceKey;
    public UUID assignedUserId;
    public UUID sopVersionId;
    public String title;

    @Column(columnDefinition = "text")
    public String description;

    public String priority;
    public Instant plannedStartAt;
    public Instant plannedEndAt;
    public BigDecimal suggestedQuantity;
    public BigDecimal plannedQuantity;
    public BigDecimal actualQuantity;
    public String unit;
    public String status = "TODO";
    public boolean quantityLocked;
    public Instant completedAt;

    @Column(columnDefinition = "text")
    public String confirmations = "[]";

    @Column(columnDefinition = "text")
    public String prerequisites = "[]";
  }

  @Entity(name = "Rule")
  @Table(name = "automation_rules")
  public static class Rule extends Tenant {
    public UUID locationId;
    public String name;
    public int priority;
    public boolean enabled = true;

    @Column(columnDefinition = "text")
    public String conditionJson;

    @Column(columnDefinition = "text")
    public String actionJson;
  }

  @Entity(name = "Variable")
  @Table(
      name = "variable_definitions",
      uniqueConstraints = @UniqueConstraint(columnNames = {"organizationId", "variableKey"}))
  public static class Variable extends Tenant {
    public String variableKey;
    public String name;
    public String unit;
    public String valueType = "NUMBER";
  }

  @Entity(name = "Log")
  @Table(
      name = "execution_logs",
      uniqueConstraints = @UniqueConstraint(columnNames = {"organizationId", "requestKey"}))
  public static class Log extends Tenant {
    public UUID taskId;
    public UUID actorId;
    public String action;
    public String requestKey;

    @Column(columnDefinition = "text")
    public String details;
  }

  @Entity(name = "Handover")
  @Table(name = "handovers")
  public static class Handover extends Tenant {
    public UUID locationId;
    public LocalDate businessDate;
    public UUID authorId;
    public UUID recipientId;

    @Column(columnDefinition = "text")
    public String content;
  }

  @Entity(name = "Media")
  @Table(name = "media_files")
  public static class Media extends Tenant {
    public UUID uploadedBy;
    public String contentType;
    public long byteSize;
  }

  @Entity(name = "Audit")
  @Table(name = "audit_logs")
  public static class Audit extends Tenant {
    public UUID actorId;
    public String action;
    public UUID resourceId;

    @Column(columnDefinition = "text")
    public String details;
  }
}
