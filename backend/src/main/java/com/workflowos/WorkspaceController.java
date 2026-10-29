package com.workflowos;

import static com.workflowos.common.Errors.require;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.workflowos.Model.*;
import jakarta.persistence.*;
import jakarta.servlet.http.HttpSession;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.text.Normalizer;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/orgs/{org}")
@Transactional
public class WorkspaceController {
  @PersistenceContext EntityManager em;
  final Access a;
  final ObjectMapper json;
  final WorkItemRegistry workItems;
  final WorkflowLinks workflowLinks;

  public WorkspaceController(Access a, ObjectMapper j, WorkItemRegistry workItems, WorkflowLinks workflowLinks) {
    this.a = a;
    json = j;
    this.workItems = workItems;
    this.workflowLinks = workflowLinks;
  }

  String encode(Object o) {
    try {
      return json.writeValueAsString(o);
    } catch (Exception e) {
      throw new IllegalArgumentException("内容格式有问题，请重新打开后再保存");
    }
  }

  JsonNode parse(String s) {
    try {
      return json.readTree(s);
    } catch (Exception e) {
      throw new IllegalArgumentException("内容格式有问题，请重新打开后再保存");
    }
  }

  static String hash(String s) {
    try {
      return HexFormat.of()
          .formatHex(
              MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  @GetMapping("/locations")
  public List<Location> locations(@PathVariable UUID org, HttpSession s) {
    a.member(org, s, false);
    return a.list(Location.class, org);
  }

  @PostMapping("/locations")
  public Location location(
      @PathVariable UUID org, @RequestBody Map<String, String> b, HttpSession s) {
    a.member(org, s, true);
    require(b.get("name") != null && !b.get("name").isBlank(), "地点名称必填");
    Location l = new Location();
    l.organizationId = org;
    l.name = b.get("name");
    l.timezone = ZoneId.of(b.getOrDefault("timezone", "Asia/Tokyo")).getId();
    em.persist(l);
    return l;
  }

  @GetMapping("/members")
  public List<Map<String, Object>> members(@PathVariable UUID org, HttpSession s) {
    a.member(org, s, false);
    return a.list(Member.class, org).stream()
        .map(
            m -> {
              Account u = em.find(Account.class, m.userId);
              return Map.<String, Object>of(
                  "id",
                  m.id,
                  "userId",
                  m.userId,
                  "name",
                  u.displayName,
                  "role",
                  m.role,
                  "status",
                  m.status);
            })
        .toList();
  }

  @PostMapping("/members/{id}/role")
  public Member role(
      @PathVariable UUID org,
      @PathVariable UUID id,
      @RequestBody Map<String, String> b,
      HttpSession s) {
    Member actor = a.member(org, s, true);
    require(actor.role.equals("OWNER"), "仅所有者可分配角色");
    Member m = a.get(Member.class, id, org);
    require(!m.role.equals("OWNER"), "不能修改所有者角色");
    require(Set.of("MANAGER", "EMPLOYEE").contains(b.get("role")), "角色无效");
    m.role = b.get("role");
    a.audit(org, a.user(s), "MEMBER_ROLE", id, m.role);
    return m;
  }

  @PostMapping("/invitations")
  public Map<String, Object> invite(
      @PathVariable UUID org, @RequestBody Map<String, String> b, HttpSession s) {
    Member actor = a.member(org, s, true);
    String role = b.getOrDefault("role", "EMPLOYEE");
    require(Set.of("MANAGER", "EMPLOYEE").contains(role), "角色无效");
    require(!role.equals("MANAGER") || actor.role.equals("OWNER"), "仅所有者可邀请管理员");
    require(b.get("email") != null && b.get("email").contains("@"), "邮箱无效");
    String token = UUID.randomUUID() + "-" + UUID.randomUUID();
    Invitation i = new Invitation();
    i.organizationId = org;
    i.email = b.get("email").toLowerCase().trim();
    i.role = role;
    i.tokenHash = hash(token);
    i.expiresAt = Instant.now().plusSeconds(604800);
    em.persist(i);
    return Map.of("id", i.id, "token", token, "expiresAt", i.expiresAt);
  }

  @PostMapping("/invitations/accept")
  public Member accept(@PathVariable UUID org, @RequestBody Map<String, String> b, HttpSession s) {
    UUID uid = a.user(s);
    Invitation i =
        em.createQuery("from Invitation where organizationId=:o and tokenHash=:t", Invitation.class)
            .setParameter("o", org)
            .setParameter("t", hash(b.getOrDefault("token", "")))
            .setLockMode(LockModeType.PESSIMISTIC_WRITE)
            .getResultStream()
            .findFirst()
            .orElseThrow(() -> new IllegalArgumentException("邀请无效"));
    require(!i.accepted && i.expiresAt.isAfter(Instant.now()), "邀请已使用或过期");
    require(em.find(Account.class, uid).email.equals(i.email), "请使用受邀邮箱登录");
    Member m = new Member();
    m.organizationId = org;
    m.userId = uid;
    m.role = i.role;
    i.accepted = true;
    em.persist(m);
    return m;
  }

  @GetMapping("/sops")
  public List<Sop> sops(@PathVariable UUID org, HttpSession s) {
    a.member(org, s, false);
    return a.list(Sop.class, org);
  }

  public record SopInput(String title, String category, JsonNode steps) {}

  public record SopSaveInput(
      UUID id, Long expectedRevision, String title, String category, JsonNode steps,
      String boardSettings, boolean draftOnly, UUID createRequestId) {}

  public record SopDeleteInput(Long expectedRevision) {}

  static String normalizeStepName(String title) {
    String normalized = Normalizer.normalize(title, Normalizer.Form.NFC);
    int start = 0, end = normalized.length();
    while (start < end && isNamePadding(normalized.charAt(start))) start++;
    while (end > start && isNamePadding(normalized.charAt(end - 1))) end--;
    return normalized.substring(start, end);
  }

  // ECMAScript trim() includes NBSP and FEFF, but excludes Java's U+001C–U+001F.
  static boolean isNamePadding(char c) {
    return switch (c) {
      case '\t', '\n', '\u000B', '\f', '\r', '\u2028', '\u2029', '\uFEFF' -> true;
      default -> Character.getType(c) == Character.SPACE_SEPARATOR;
    };
  }

  void validateSteps(JsonNode steps, UUID org, String boardSettings) {
    validateSteps(steps, org, boardSettings, false);
  }

  void validateSteps(JsonNode steps, UUID org, String boardSettings, boolean draftOnly) {
    require(steps != null && steps.isArray() && steps.size() <= 200, "内容格式有问题，请重新打开后再保存");
    Set<String> moduleNames = new HashSet<>();
    Set<String> detailNames = new HashSet<>();
    Set<String> detailIds = new HashSet<>();
    int legacyCount = 0, detailCount = 0;
    for (JsonNode n : steps) {
      if (n.has("kind")) {
        String kind = n.path("kind").asText();
        require(kind.equals("MODULE") || kind.equals("DETAIL"), "内容格式有问题，请重新打开后再保存");
        require(n.path("title").isTextual(), "内容格式有问题，请重新打开后再保存");
        String name = normalizeStepName(n.path("title").asText());
        require(draftOnly && kind.equals("DETAIL") || !name.isEmpty(), "请给每项工作或具体做法起个名字");
        Set<String> names = kind.equals("MODULE") ? moduleNames : detailNames;
        if (!name.isEmpty())
          require(names.add(name), kind.equals("MODULE") ? "工作名称不能重复" : "具体做法名称不能重复");
        require(names.size() <= 100, kind.equals("MODULE") ? "每个流程最多添加 100 项工作" : "每个流程最多添加 100 份具体做法");
        if (kind.equals("DETAIL")) {
          require(++detailCount <= 100, "每个流程最多添加 100 份具体做法");
          if (draftOnly) {
            JsonNode id = n.path("id");
            require(id.isTextual() && !normalizeStepName(id.asText()).isEmpty()
                && id.asText().length() <= 255,
                "具体做法的信息不完整，请重新打开后再保存");
            require(detailIds.add(id.asText()), "具体做法的信息有重复，请重新打开后再保存");
          }
          JsonNode items = n.path("items");
          boolean preservedEmptyLegacy =
              n.path("legacyEmpty").isBoolean()
                  && n.path("legacyEmpty").asBoolean()
                  && (!n.has("description")
                      || (n.path("description").isTextual()
                          && normalizeStepName(n.path("description").asText()).isEmpty()));
          require(
              items.isArray()
                  && (draftOnly || preservedEmptyLegacy || !items.isEmpty())
                  && items.size() <= 100,
              draftOnly ? "具体做法的清单最多保留 100 条" : "具体做法的清单请填写 1 至 100 条");
          for (JsonNode item : items)
            require(
                item.isObject() && item.path("text").isTextual()
                    && (draftOnly || !item.path("text").asText().isBlank()),
                "请把清单里的每一条做法写完整");
        }
      } else {
        require(!n.path("title").asText().isBlank(), "请给每项工作或具体做法起个名字");
        require(++legacyCount <= 100, "每个流程最多添加 100 项工作");
      }
      for (String key : List.of("imageUrl", "videoUrl")) {
        String u = n.path(key).asText();
        require(
            u.isEmpty() || u.startsWith("https://") || u.startsWith("/api/orgs/" + org + "/files/"),
            "图片或视频链接请以 https:// 开头");
      }
    }
    JsonNode canvas = boardSettings == null ? json.nullNode() : parse(boardSettings).path("canvas");
    WorkItemRegistry.validateLayout(steps,
        validCanvasSize(canvas) ? canvas.path("width").intValue() : 820,
        validCanvasSize(canvas) ? canvas.path("height").intValue() : 820);
  }

  String validateBoardSettings(String value) {
    require(value.length() <= 8192, "流程图设置有问题，请重新打开后再试");
    JsonNode settings = parse(value);
    require(settings != null && settings.isObject(), "流程图设置有问题，请重新打开后再试");
    JsonNode version = settings.path("version");
    JsonNode timeline = settings.path("timeline");
    JsonNode priority = settings.path("priority");
    require(
        version.isIntegralNumber()
            && version.canConvertToInt()
            && version.intValue() == 1
            && timeline.isObject()
            && timeline.path("enabled").isBoolean()
            && priority.isObject()
            && priority.path("enabled").isBoolean(),
        "流程图设置有问题，请重新打开后再试");
    for (String key : List.of("startMinute", "endMinute")) {
      JsonNode minute = timeline.path(key);
      require(
          minute.isIntegralNumber()
              && minute.canConvertToInt()
              && minute.intValue() >= 0
              && minute.intValue() <= 1439,
          "开始和结束时间有问题，请重新选一下");
    }
    require(
        timeline.path("startMinute").intValue() != timeline.path("endMinute").intValue(),
        "开始和结束时间不能一样");
    int duration = Math.floorMod(
        timeline.path("endMinute").intValue() - timeline.path("startMinute").intValue(),
        1440);
    if (timeline.has("focus") && !timeline.path("focus").isNull()) {
      JsonNode focus = timeline.path("focus");
      JsonNode start = focus.path("startOffset");
      JsonNode end = focus.path("endOffset");
      JsonNode scale = focus.path("scale");
      require(
          focus.isObject()
              && start.isIntegralNumber() && start.canConvertToInt()
              && end.isIntegralNumber() && end.canConvertToInt()
              && start.intValue() >= 0
              && start.intValue() < end.intValue()
              && end.intValue() <= duration
              && scale.isNumber() && Double.isFinite(scale.doubleValue())
              && scale.doubleValue() >= 1 && scale.doubleValue() <= 10,
          "请重新选择要拉宽的时间段，放大倍数需要在 1 到 10 之间");
    }
    if (timeline.has("segments") && !timeline.path("segments").isNull()) {
      JsonNode segments = timeline.path("segments");
      require(segments.isArray() && segments.size() <= 96,
          "时间段设置有问题，请重新调整每段长度");
      int previousStart = -1, previousEnd = 0;
      for (JsonNode segment : segments) {
        JsonNode start = segment.path("startOffset");
        JsonNode end = segment.path("endOffset");
        JsonNode scale = segment.path("scale");
        require(
            segment.isObject()
                && start.isIntegralNumber() && start.canConvertToInt()
                && end.isIntegralNumber() && end.canConvertToInt()
                && start.intValue() >= 0 && start.intValue() < end.intValue()
                && end.intValue() <= duration
                && start.intValue() > previousStart && start.intValue() >= previousEnd
                && scale.isNumber() && Double.isFinite(scale.doubleValue())
                && scale.doubleValue() >= 1e-6 && scale.doubleValue() <= 10000,
            "时间段不能重叠或超出时间范围，长度需要在允许范围内");
        previousStart = start.intValue();
        previousEnd = end.intValue();
      }
    }
    for (JsonNode axis : List.of(timeline, priority)) {
      if (axis.has("axis"))
        require(
            axis.path("axis").isTextual()
                && Set.of("x", "y").contains(axis.path("axis").asText()),
            "坐标方向有问题，请重新选一下");
    }
    String timelineAxis = timelineDirection(timeline, priority);
    String priorityAxis = priority.has("axis")
        ? priority.path("axis").asText() : timelineAxis.equals("x") ? "y" : "x";
    require(
        !timeline.path("enabled").asBoolean()
            || !priority.path("enabled").asBoolean()
            || !timelineAxis.equals(priorityAxis),
        "时间和先后安排不能放在同一个方向，请换一个方向");
    if (settings.has("canvas"))
      require(validCanvasSize(settings.path("canvas")), "画板的宽和高请填写 320 到 2400 之间的整数");
    if (settings.has("referenceCanvas"))
      require(validCanvasSize(settings.path("referenceCanvas")), "画板大小的信息有问题，请重新打开后再试");
    return encode(settings);
  }

  String timelineDirection(JsonNode timeline, JsonNode priority) {
    return timeline.has("axis")
        ? timeline.path("axis").asText()
        : priority.has("axis") && priority.path("axis").asText().equals("x") ? "y" : "x";
  }

  boolean validCanvasSize(JsonNode canvas) {
    if (canvas == null || !canvas.isObject()) return false;
    for (String key : List.of("width", "height")) {
      JsonNode dimension = canvas.path(key);
      if (!dimension.isIntegralNumber()
          || !dimension.canConvertToInt()
          || dimension.intValue() < 320
          || dimension.intValue() > 2400) return false;
    }
    return true;
  }

  String preserveBoardSizes(String requested, String stored) {
    if (stored == null) return requested;
    ObjectNode settings = (ObjectNode) parse(requested);
    JsonNode previous = parse(stored);
    boolean changed = false;
    for (String key : List.of("canvas", "referenceCanvas")) {
      if (!settings.has(key) && validCanvasSize(previous.path(key))) {
        settings.set(key, previous.path(key));
        changed = true;
      }
    }
    ObjectNode timeline = (ObjectNode) settings.path("timeline");
    JsonNode previousTimeline = previous.path("timeline");
    boolean sameTimeline =
        timeline.path("startMinute").equals(previousTimeline.path("startMinute"))
            && timeline.path("endMinute").equals(previousTimeline.path("endMinute"))
            && timelineDirection(timeline, settings.path("priority"))
                .equals(timelineDirection(previousTimeline, previous.path("priority")));
    if (!timeline.has("focus") && previousTimeline.has("focus")) {
      timeline.set("focus", sameTimeline ? previousTimeline.path("focus") : json.nullNode());
      changed = true;
    }
    if (!timeline.has("segments") && previousTimeline.has("segments")) {
      timeline.set("segments", sameTimeline ? previousTimeline.path("segments") : json.nullNode());
      changed = true;
    }
    return changed ? validateBoardSettings(encode(settings)) : requested;
  }

  boolean sameBoardSettings(String left, String right) {
    return left == null || right == null
        ? Objects.equals(left, right)
        : parse(left).equals(parse(right));
  }

  @PostMapping("/sops")
  public Sop createSop(@PathVariable UUID org, @RequestBody SopInput b, HttpSession s) {
    a.member(org, s, true);
    workflowLinks.lock(org);
    validateSteps(b.steps, org, null);
    require(b.title != null && !b.title.isBlank(), "请填写流程名称");
    Sop sop = new Sop();
    sop.organizationId = org;
    List<Sop> library = workflowLinks.library(org);
    workflowLinks.validateBindings(sop, b.steps, library);
    JsonNode steps = workflowLinks.materializeBoundDocuments(sop, b.steps, library);
    sop.title = b.title;
    sop.category = b.category;
    sop.draft = encode(steps);
    em.persist(sop);
    workItems.synchronize(sop);
    return sop;
  }

  @PutMapping("/sops/{id}")
  public Sop editSop(
      @PathVariable UUID org, @PathVariable UUID id, @RequestBody SopInput b, HttpSession s) {
    a.member(org, s, true);
    workflowLinks.lock(org);
    Sop sop = a.get(Sop.class, id, org);
    em.lock(sop, LockModeType.PESSIMISTIC_WRITE);
    validateSteps(b.steps, org, sop.boardSettings);
    require(b.title != null && !b.title.isBlank(), "请填写流程名称");
    List<Sop> library = workflowLinks.library(org);
    workflowLinks.validateBindings(sop, b.steps, library);
    workflowLinks.validateRemovedDetails(sop, b.steps, library);
    JsonNode steps = workflowLinks.materializeBoundDocuments(sop, b.steps, library);
    steps = workflowLinks.preserveRenamedReferences(sop, steps, library);
    sop.title = b.title;
    sop.category = b.category;
    sop.draft = encode(steps);
    workItems.synchronize(sop);
    a.audit(org, a.user(s), "SOP_DRAFT_EDIT", id, sop.draft);
    return sop;
  }

  @PostMapping("/sops/{id}/publish")
  public SopVersion publish(@PathVariable UUID org, @PathVariable UUID id, HttpSession s) {
    a.member(org, s, true);
    Sop sop = a.get(Sop.class, id, org);
    em.lock(sop, LockModeType.PESSIMISTIC_WRITE);
    JsonNode steps = parse(sop.draft);
    validateSteps(steps, org, sop.boardSettings);
    require(!steps.isEmpty(), "这个流程还是空的，请先添加一项工作或具体做法");
    return publishVersion(sop, a.user(s));
  }

  @PostMapping("/sops/save")
  public Sop saveSop(@PathVariable UUID org, @RequestBody SopSaveInput b, HttpSession s) {
    a.member(org, s, true);
    workflowLinks.lock(org);
    require(b.title != null && !b.title.isBlank(), "请填写流程名称");
    String boardSettings = b.boardSettings == null ? null : validateBoardSettings(b.boardSettings);
    require(b.id == null || b.createRequestId == null, "添加流程和修改流程的信息不能混用");

    Sop sop;
    if (b.id == null) {
      if (b.createRequestId != null) {
        Sop existing = em.find(Sop.class, b.createRequestId);
        if (existing != null) {
          if (!existing.organizationId.equals(org))
            throw new ResponseStatusException(HttpStatus.CONFLICT, "这次添加的信息已被使用，请重新生成后再试");
          // A retried creation is a receipt lookup, never an edit of the created flow.
          return existing;
        }
      }
      sop = new Sop();
      if (b.createRequestId != null) sop.id = b.createRequestId;
      sop.organizationId = org;
      em.persist(sop);
    } else {
      require(b.expectedRevision != null, "页面信息不完整，请刷新后重试");
      sop =
          em.createQuery("from Sop where id=:id and organizationId=:org", Sop.class)
              .setParameter("id", b.id)
              .setParameter("org", org)
              .setLockMode(LockModeType.PESSIMISTIC_WRITE)
              .getResultStream()
              .findFirst()
              .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "没有找到这项内容"));
      if (sop.revision != b.expectedRevision)
        throw new ResponseStatusException(HttpStatus.CONFLICT, "内容已经更新，请刷新后再试");
      if (b.boardSettings == null) boardSettings = sop.boardSettings;
      else boardSettings = preserveBoardSizes(boardSettings, sop.boardSettings);
    }

    validateSteps(b.steps, org, boardSettings, b.draftOnly);
    List<Sop> library = workflowLinks.library(org);
    workflowLinks.validateBindings(sop, b.steps, library);
    workflowLinks.validateRemovedDetails(sop, b.steps, library);
    JsonNode steps = workflowLinks.materializeBoundDocuments(sop, b.steps, library);
    steps = workflowLinks.preserveRenamedReferences(sop, steps, library);

    boolean unchangedDraft = Objects.equals(sop.title, b.title)
        && Objects.equals(sop.category, b.category)
        && parse(sop.draft).equals(steps)
        && sameBoardSettings(sop.boardSettings, boardSettings);
    if (b.draftOnly && unchangedDraft) {
      workItems.synchronize(sop);
      em.flush();
      return sop;
    }

    // A repeated save of the same published content does not need another history entry.
    if (sop.status.equals("PUBLISHED")
        && unchangedDraft
        && sop.currentVersionId != null) {
      SopVersion current = a.get(SopVersion.class, sop.currentVersionId, org);
      if (Objects.equals(current.title, b.title)
          && parse(current.steps).equals(steps)
          && sameBoardSettings(current.boardSettings, boardSettings)) {
        workItems.synchronize(sop);
        return sop;
      }
    }

    sop.title = b.title;
    sop.category = b.category;
    sop.draft = encode(steps);
    sop.boardSettings = boardSettings;
    if (b.draftOnly) workItems.synchronize(sop);
    else publishVersion(sop, a.user(s));
    // Return the committed revision so the next edit can use it for its conflict check.
    em.flush();
    return sop;
  }

  SopVersion publishVersion(Sop sop, UUID actor) {
    workItems.synchronize(sop);
    UUID org = sop.organizationId;
    UUID id = sop.id;
    SopVersion v = new SopVersion();
    v.organizationId = org;
    v.sopId = id;
    v.title = sop.title;
    v.steps = sop.draft;
    v.boardSettings = sop.boardSettings;
    v.versionNumber =
        em.createQuery("select count(v) from SopVersion v where sopId=:s", Long.class)
                .setParameter("s", id)
                .getSingleResult()
                .intValue()
            + 1;
    v.publishedAt = Instant.now();
    v.publishedBy = actor;
    em.persist(v);
    sop.currentVersionId = v.id;
    sop.status = "PUBLISHED";
    a.audit(org, actor, "SOP_PUBLISH", id, encode(Map.of("version", v.versionNumber)));
    return v;
  }

  @PostMapping("/sops/{id}/archive")
  public Sop archive(@PathVariable UUID org, @PathVariable UUID id, HttpSession s) {
    a.member(org, s, true);
    Sop sop = a.get(Sop.class, id, org);
    em.lock(sop, LockModeType.PESSIMISTIC_WRITE);
    sop.status = "ARCHIVED";
    a.audit(org, a.user(s), "SOP_ARCHIVE", id, "");
    return sop;
  }

  @DeleteMapping("/sops/{id}")
  @ResponseStatus(HttpStatus.NO_CONTENT)
  public void deleteSop(
      @PathVariable UUID org,
      @PathVariable UUID id,
      @RequestBody SopDeleteInput b,
      HttpSession s) {
    a.member(org, s, true);
    workflowLinks.lock(org);
    require(b.expectedRevision != null, "页面信息不完整，请刷新后重试");
    Sop sop =
        em.createQuery("from Sop where id=:id and organizationId=:org", Sop.class)
            .setParameter("id", id)
            .setParameter("org", org)
            .setLockMode(LockModeType.PESSIMISTIC_WRITE)
            .getResultStream()
            .findFirst()
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "没有找到这项内容"));
    if (sop.revision != b.expectedRevision)
      throw new ResponseStatusException(HttpStatus.CONFLICT, "内容已经更新，请刷新后再试");

    List<String> dependents = workflowLinks.dependents(sop, workflowLinks.library(org));
    if (!dependents.isEmpty())
      throw new ResponseStatusException(HttpStatus.CONFLICT,
          "这些流程还在使用这里的做法，暂时不能删除：「" + String.join("」、「", dependents)
              + "」。请先更换或移除对应工作");

    long templateReferences =
        em.createQuery(
                "select count(t) from Template t where t.organizationId=:org and t.sopId=:id",
                Long.class)
            .setParameter("org", org)
            .setParameter("id", id)
            .getSingleResult();
    long taskReferences =
        em.createQuery(
                "select count(t) from Task t where t.organizationId=:org and t.sopVersionId in"
                    + " (select v.id from SopVersion v where v.organizationId=:org and v.sopId=:id)",
                Long.class)
            .setParameter("org", org)
            .setParameter("id", id)
            .getSingleResult();
    if (templateReferences > 0 || taskReferences > 0)
      throw new ResponseStatusException(
          HttpStatus.CONFLICT, "还有旧工作在使用这个流程，暂时不能删除");

    // Break the current-version cycle before removing the workflow's history.
    sop.currentVersionId = null;
    em.flush();
    em.createQuery("delete from WorkItem where organizationId=:org and workflowId=:id")
        .setParameter("org", org)
        .setParameter("id", id)
        .executeUpdate();
    em.createQuery("delete from SopVersion where organizationId=:org and sopId=:id")
        .setParameter("org", org)
        .setParameter("id", id)
        .executeUpdate();
    a.audit(org, a.user(s), "SOP_DELETE", id, encode(Map.of("title", sop.title)));
    em.remove(sop);
    em.flush();
  }

  @GetMapping("/sops/{id}/versions")
  public List<SopVersion> versions(@PathVariable UUID org, @PathVariable UUID id, HttpSession s) {
    a.member(org, s, false);
    a.get(Sop.class, id, org);
    return a.list(SopVersion.class, org).stream()
        .filter(v -> v.sopId.equals(id))
        .sorted(Comparator.comparingInt((SopVersion v) -> v.versionNumber).reversed())
        .toList();
  }

  @GetMapping("/templates")
  public List<Template> templates(@PathVariable UUID org, HttpSession s) {
    a.member(org, s, false);
    return a.list(Template.class, org);
  }

  void validateTemplate(Template t, UUID org) {
    a.get(Location.class, t.locationId, org);
    require(t.name != null && !t.name.isBlank(), "任务名称必填");
    LocalTime.parse(t.startTime);
    require(t.durationMinutes > 0 && t.durationMinutes <= 1440, "耗时应为 1–1440 分钟");
    require(Set.of("LOW", "NORMAL", "HIGH").contains(t.priority), "优先级无效");
    if (t.sopId != null) a.get(Sop.class, t.sopId, org);
    if (t.assignedUserId != null)
      require(
          a.list(Member.class, org).stream()
              .anyMatch(m -> m.userId.equals(t.assignedUserId) && m.status.equals("ACTIVE")),
          "负责人不在组织内");
    JsonNode r = parse(t.recurrence);
    require(Set.of("DAILY", "WEEKDAYS", "RANGE").contains(r.path("type").asText()), "重复规则无效");
    if (r.path("type").asText().equals("WEEKDAYS")) {
      require(r.path("days").isArray() && !r.path("days").isEmpty(), "请选择星期");
      for (JsonNode d : r.path("days"))
        require(d.isInt() && d.asInt() >= 1 && d.asInt() <= 7, "星期必须为 1–7");
    }
    if (r.path("type").asText().equals("RANGE"))
      require(
          !LocalDate.parse(r.path("end").asText())
              .isBefore(LocalDate.parse(r.path("start").asText())),
          "日期范围无效");
    require(t.quantity == null || t.quantity.signum() >= 0, "数量不能为负");
    JsonNode p = parse(t.prerequisites);
    require(p.isArray(), "前置任务无效");
    for (JsonNode n : p) {
      Template dep = a.get(Template.class, UUID.fromString(n.asText()), org);
      require(dep.locationId.equals(t.locationId), "前置任务必须属于相同地点");
      require(!dep.id.equals(t.id), "任务不能依赖自身");
      checkCycle(dep, t.id, org, new HashSet<>());
    }
  }

  void checkCycle(Template current, UUID target, UUID org, Set<UUID> visited) {
    require(!current.id.equals(target), "前置任务存在循环依赖");
    if (!visited.add(current.id)) return;
    for (JsonNode n : parse(current.prerequisites))
      checkCycle(a.get(Template.class, UUID.fromString(n.asText()), org), target, org, visited);
  }

  @PostMapping("/templates")
  public Template createTemplate(@PathVariable UUID org, @RequestBody Template b, HttpSession s) {
    a.member(org, s, true);
    b.id = UUID.randomUUID();
    b.createdAt = Instant.now();
    b.revision = 0;
    b.organizationId = org;
    validateTemplate(b, org);
    em.persist(b);
    a.audit(org, a.user(s), "TEMPLATE_CREATE", b.id, encode(b));
    return b;
  }

  @PutMapping("/templates/{id}")
  public Template editTemplate(
      @PathVariable UUID org, @PathVariable UUID id, @RequestBody Template b, HttpSession s) {
    a.member(org, s, true);
    Template t = a.get(Template.class, id, org);
    require(t.locationId.equals(b.locationId), "不能将现有模板移动到其他地点，请新建模板");
    b.id = id;
    validateTemplate(b, org);
    t.name = b.name;
    t.description = b.description;
    t.category = b.category;
    t.startTime = b.startTime;
    t.durationMinutes = b.durationMinutes;
    t.priority = b.priority;
    t.sopId = b.sopId;
    t.assignedUserId = b.assignedUserId;
    t.active = b.active;
    t.recurrence = b.recurrence;
    t.prerequisites = b.prerequisites;
    t.quantity = b.quantity;
    t.unit = b.unit;
    a.audit(org, a.user(s), "TEMPLATE_EDIT", id, encode(b));
    return t;
  }

  @GetMapping("/variables")
  public List<Variable> variables(@PathVariable UUID org, HttpSession s) {
    a.member(org, s, false);
    return a.list(Variable.class, org);
  }

  @PostMapping("/variables")
  public Variable variable(@PathVariable UUID org, @RequestBody Variable b, HttpSession s) {
    a.member(org, s, true);
    require(
        b.variableKey != null
            && b.variableKey.matches("[a-z][a-z0-9_]{0,40}")
            && b.name != null
            && !b.name.isBlank(),
        "变量键或名称无效");
    require(b.valueType.equals("NUMBER"), "当前版本只支持数值变量");
    b.id = UUID.randomUUID();
    b.createdAt = Instant.now();
    b.revision = 0;
    b.organizationId = org;
    em.persist(b);
    return b;
  }

  @GetMapping("/rules")
  public List<Rule> rules(@PathVariable UUID org, HttpSession s) {
    a.member(org, s, true);
    return a.list(Rule.class, org);
  }

  @PostMapping("/rules")
  public Rule rule(@PathVariable UUID org, @RequestBody Rule b, HttpSession s) {
    a.member(org, s, true);
    a.get(Location.class, b.locationId, org);
    require(b.name != null && !b.name.isBlank(), "规则名称必填");
    parse(b.conditionJson);
    JsonNode actions = parse(b.actionJson);
    require(actions.isArray() && !actions.isEmpty() && actions.size() <= 50, "动作必须为数组且不为空");
    for (JsonNode action : actions) {
      require(
          Set.of("SET_QUANTITY", "ADD_TASK", "NOTICE").contains(action.path("type").asText()),
          "规则动作无效");
      if (!action.path("type").asText().equals("NOTICE")) {
        Template t =
            a.get(Template.class, UUID.fromString(action.path("templateId").asText()), org);
        require(t.locationId.equals(b.locationId), "规则模板不属于当前地点");
      }
    }
    b.id = UUID.randomUUID();
    b.createdAt = Instant.now();
    b.revision = 0;
    b.organizationId = org;
    em.persist(b);
    a.audit(org, a.user(s), "RULE_CREATE", b.id, encode(b));
    return b;
  }

  @PostMapping("/rules/{id}/toggle")
  public Rule toggle(@PathVariable UUID org, @PathVariable UUID id, HttpSession s) {
    a.member(org, s, true);
    Rule r = a.get(Rule.class, id, org);
    r.enabled = !r.enabled;
    a.audit(org, a.user(s), "RULE_TOGGLE", id, Boolean.toString(r.enabled));
    return r;
  }

  @GetMapping("/handovers")
  public List<Handover> handovers(
      @PathVariable UUID org,
      @RequestParam UUID locationId,
      @RequestParam LocalDate date,
      HttpSession s) {
    a.member(org, s, false);
    a.get(Location.class, locationId, org);
    return a.list(Handover.class, org).stream()
        .filter(h -> h.locationId.equals(locationId) && h.businessDate.equals(date))
        .toList();
  }

  @PostMapping("/handovers")
  public Handover handover(@PathVariable UUID org, @RequestBody Handover b, HttpSession s) {
    a.member(org, s, false);
    a.get(Location.class, b.locationId, org);
    require(
        b.content != null
            && !b.content.isBlank()
            && b.content.length() <= 10000
            && b.businessDate != null,
        "请填写交接日期和内容");
    if (b.recipientId != null)
      require(
          a.list(Member.class, org).stream().anyMatch(m -> m.userId.equals(b.recipientId)),
          "接收人不在组织内");
    b.id = UUID.randomUUID();
    b.createdAt = Instant.now();
    b.revision = 0;
    b.organizationId = org;
    b.authorId = a.user(s);
    em.persist(b);
    return b;
  }

  @GetMapping("/audit")
  public List<Audit> audit(@PathVariable UUID org, HttpSession s) {
    a.member(org, s, true);
    return a.list(Audit.class, org);
  }
}
