package com.workflowos;

import static org.junit.jupiter.api.Assertions.*;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.io.IOException;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

class DiagramPreviewServiceTest {
  final ObjectMapper json = new ObjectMapper();
  final String source = "首先清洗豆芽。\n同时烧开水。然后把豆芽放入开水，煮两分钟。";

  DiagramPreviewService service(DiagramPreviewService.Transport transport) {
    return new DiagramPreviewService(json, true, "unit-test-key", "gpt-5.4-mini", transport,
        Clock.fixed(Instant.parse("2026-10-28T00:00:00Z"), ZoneOffset.UTC));
  }

  ObjectNode diagram() {
    ObjectNode result = json.createObjectNode().put("title", "煮豆芽");
    ArrayNode nodes = result.putArray("nodes");
    nodes.addObject().put("id", "wash").put("name", "清洗豆芽")
        .putArray("details").add("首先清洗豆芽。");
    ((ObjectNode) nodes.get(0)).putArray("nextIds").add("cook");
    nodes.addObject().put("id", "water").put("name", "烧开水")
        .putArray("details").add("同时烧开水。");
    ((ObjectNode) nodes.get(1)).putArray("nextIds").add("cook");
    nodes.addObject().put("id", "cook").put("name", "煮豆芽")
        .putArray("details").add("然后把豆芽放入开水，煮两分钟。");
    ((ObjectNode) nodes.get(2)).putArray("nextIds");
    return result;
  }

  String response(JsonNode diagram) {
    ObjectNode reply = json.createObjectNode().put("status", "completed");
    reply.putArray("output").addObject().put("type", "message").put("status", "completed")
        .putArray("content").addObject().put("type", "output_text").put("text", diagram.toString());
    return reply.toString();
  }

  DiagramPreviewService serviceWith(JsonNode diagram) {
    return service(request -> new DiagramPreviewService.ProviderReply(200, response(diagram)));
  }

  ResponseStatusException rejected(DiagramPreviewService service, int status) {
    ResponseStatusException error = assertThrows(ResponseStatusException.class,
        () -> service.preview(UUID.randomUUID(), source));
    assertEquals(status, error.getStatusCode().value());
    assertFalse(error.getReason().contains(source));
    assertFalse(error.getReason().contains("unit-test-key"));
    return error;
  }

  @Test
  void extractsVerbatimDetailsAndParallelBranchesWithoutPersistingOrAddingWork() {
    var result = serviceWith(diagram()).preview(UUID.randomUUID(), source);
    assertEquals("煮豆芽", result.title());
    assertEquals(3, result.nodes().size());
    assertEquals(List.of("cook"), result.nodes().get(0).nextIds());
    assertEquals(List.of("cook"), result.nodes().get(1).nextIds());
    assertEquals(List.of("然后把豆芽放入开水，煮两分钟。"), result.nodes().get(2).details());
    assertTrue(result.nodes().get(2).nextIds().isEmpty());
  }

  @Test
  void requestUsesFixedResponsesEndpointStrictSchemaNoStorageAndSingleUserInput() throws Exception {
    AtomicReference<HttpRequest> captured = new AtomicReference<>();
    service(request -> {
      captured.set(request);
      return new DiagramPreviewService.ProviderReply(200, response(diagram()));
    }).preview(UUID.randomUUID(), source);
    HttpRequest request = captured.get();
    assertEquals("https://api.openai.com/v1/responses", request.uri().toString());
    assertEquals("POST", request.method());
    assertEquals(Duration.ofSeconds(90), request.timeout().orElseThrow());
    assertEquals("Bearer unit-test-key", request.headers().firstValue("Authorization").orElseThrow());
    var body = new CompletableFuture<String>();
    var bytes = new java.io.ByteArrayOutputStream();
    request.bodyPublisher().orElseThrow().subscribe(new Flow.Subscriber<ByteBuffer>() {
      public void onSubscribe(Flow.Subscription subscription) { subscription.request(Long.MAX_VALUE); }
      public void onNext(ByteBuffer buffer) {
        byte[] chunk = new byte[buffer.remaining()]; buffer.get(chunk); bytes.writeBytes(chunk);
      }
      public void onError(Throwable error) { body.completeExceptionally(error); }
      public void onComplete() { body.complete(bytes.toString(StandardCharsets.UTF_8)); }
    });
    JsonNode payload = json.readTree(body.get(2, TimeUnit.SECONDS));
    assertEquals("gpt-5.4-mini", payload.path("model").asText());
    assertFalse(payload.path("store").asBoolean(true));
    assertEquals(24000, payload.path("max_output_tokens").asInt());
    assertEquals(1, payload.path("input").size());
    assertEquals(source, payload.path("input").get(0).path("content").get(0).path("text").asText());
    JsonNode format = payload.path("text").path("format");
    assertEquals("json_schema", format.path("type").asText());
    assertTrue(format.path("strict").asBoolean());
    assertFalse(format.path("schema").path("additionalProperties").asBoolean(true));
    assertEquals(4, format.path("schema").path("properties").path("nodes").path("items").path("required").size());
    assertTrue(payload.path("instructions").asText().contains("不补充"));
    assertTrue(payload.path("instructions").asText().contains("保留指回该工作的连线"));
    assertFalse(payload.path("instructions").asText().contains("只指向 nodes 内后续工作"));
  }

  @Test
  void blankOversizedAndUnconfiguredInputNeverCallsTransport() {
    AtomicInteger calls = new AtomicInteger();
    DiagramPreviewService.Transport fake = request -> { calls.incrementAndGet(); throw new IOException(); };
    var configured = service(fake);
    for (String text : Arrays.asList(null, "", " \n ", "字".repeat(16001))) {
      var error = assertThrows(ResponseStatusException.class, () -> configured.preview(UUID.randomUUID(), text));
      assertEquals(400, error.getStatusCode().value());
    }
    var absent = new DiagramPreviewService(json, true, "", "", fake, Clock.systemUTC());
    assertFalse(absent.available());
    rejected(absent, 503);
    assertEquals(0, calls.get());
  }

  @Test
  void disabledPaidGenerationNeverBuildsOrSendsARequestEvenWhenAKeyExists() {
    AtomicInteger calls = new AtomicInteger();
    var disabled = new DiagramPreviewService(json, false, "unit-test-key", "gpt-5.4-mini",
        request -> { calls.incrementAndGet(); throw new AssertionError("Paid transport must not run"); },
        Clock.systemUTC()) {
      @Override String requestBody(String text) {
        throw new AssertionError("A paid request must not be built while disabled");
      }
    };
    assertFalse(disabled.available());
    assertEquals("当前使用本机免费生成，无需调用付费接口", rejected(disabled, 503).getReason());
    assertEquals(0, calls.get());
  }

  @Test
  void rejectsInventedOrRewrittenDetailRatherThanSilentlyDroppingIt() {
    for (String detail : List.of("清洗豆芽并沥干。", "然后把豆芽放入开水，煮三分钟。", " ", "")) {
      ObjectNode result = diagram();
      ((ArrayNode) result.path("nodes").get(0).path("details")).set(0, json.getNodeFactory().textNode(detail));
      rejected(serviceWith(result), 502);
    }
  }

  @Test
  void preservesWhitespaceAndNewlinesInActualSourceExcerpts() {
    ObjectNode result = diagram();
    ((ArrayNode) result.path("nodes").get(0).path("details")).set(0,
        json.getNodeFactory().textNode("首先清洗豆芽。\n同时烧开水。"));
    assertEquals("首先清洗豆芽。\n同时烧开水。", serviceWith(result)
        .preview(UUID.randomUUID(), source).nodes().get(0).details().get(0));
  }

  @Test
  void rejectsEmptyDuplicateOrMalformedNamesAndIds() {
    for (String field : List.of("id", "name")) {
      for (JsonNode bad : List.of(json.nullNode(), json.getNodeFactory().numberNode(2),
          json.getNodeFactory().textNode(""), json.getNodeFactory().textNode(" "),
          json.getNodeFactory().textNode(" padded "), json.getNodeFactory().textNode("x".repeat(121)))) {
        ObjectNode result = diagram();
        ((ObjectNode) result.path("nodes").get(0)).set(field, bad);
        rejected(serviceWith(result), 502);
      }
      ObjectNode duplicate = diagram();
      ((ObjectNode) duplicate.path("nodes").get(1)).set(field, duplicate.path("nodes").get(0).path(field));
      rejected(serviceWith(duplicate), 502);
    }
    ObjectNode normalized = diagram();
    ((ObjectNode) normalized.path("nodes").get(0)).put("name", "ABC");
    ((ObjectNode) normalized.path("nodes").get(1)).put("name", "ａｂｃ");
    rejected(serviceWith(normalized), 502);
  }

  @Test
  void rejectsUnknownSelfDuplicateAndNonStringEdges() {
    for (JsonNode targets : List.of(json.createArrayNode().add("missing"),
        json.createArrayNode().add("wash"), json.createArrayNode().add("cook").add("cook"),
        json.createArrayNode().add(7), json.nullNode(), json.getNodeFactory().textNode("cook"))) {
      ObjectNode result = diagram();
      ((ObjectNode) result.path("nodes").get(0)).set("nextIds", targets);
      rejected(serviceWith(result), 502);
    }
  }

  @Test
  void rejectsExtraFieldsEmptyResultsAndOutputLimits() {
    ObjectNode extra = diagram().put("secret", "not allowed");
    rejected(serviceWith(extra), 502);
    ObjectNode empty = diagram(); empty.putArray("nodes");
    rejected(serviceWith(empty), 502);
    ObjectNode many = diagram();
    for (int i = 0; i < 60; i++) ((ArrayNode) many.path("nodes")).add(diagram().path("nodes").get(0));
    rejected(serviceWith(many), 502);
    ObjectNode details = diagram();
    ArrayNode entries = ((ObjectNode) details.path("nodes").get(0)).putArray("details");
    for (int i = 0; i < 101; i++) entries.add("首先清洗豆芽。");
    rejected(serviceWith(details), 502);
    ObjectNode unknown = diagram(); ((ObjectNode) unknown.path("nodes").get(0)).put("other", true);
    rejected(serviceWith(unknown), 502);
  }

  @Test
  void refusalAndIncompleteResultsHaveDistinctSafeErrors() {
    String refused = """
        {"status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"private body"}]}]}
        """;
    var error = rejected(service(request -> new DiagramPreviewService.ProviderReply(200, refused)), 422);
    assertFalse(error.getReason().contains("private body"));
    rejected(service(request -> new DiagramPreviewService.ProviderReply(200,
        "{\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"}}")), 502);
    rejected(service(request -> new DiagramPreviewService.ProviderReply(200, "malformed")), 502);
  }

  @Test
  void duplicateFieldsAndTrailingJsonCannotHideRejectedDetails() {
    String valid = response(diagram());
    rejected(service(request -> new DiagramPreviewService.ProviderReply(200, valid + " {}")), 502);
    ObjectNode reply = json.createObjectNode().put("status", "completed");
    String duplicate = diagram().toString().replace("\"details\":[", "\"details\":[\"invented\"],\"details\":[");
    reply.putArray("output").addObject().put("type", "message").putArray("content")
        .addObject().put("type", "output_text").put("text", duplicate);
    rejected(service(request -> new DiagramPreviewService.ProviderReply(200, reply.toString())), 502);
  }

  @Test
  void providerStatusesDistinguishQuotaRateAndConfigurationWithoutLeakingBodies() {
    for (int status : List.of(401, 403, 404, 500, 503)) {
      int expected = status == 401 || status == 403 ? 503 : 502;
      var error = rejected(service(request -> new DiagramPreviewService.ProviderReply(status,
          "private provider body with unit-test-key")), expected);
      assertFalse(error.getReason().contains("private provider"));
    }
    var quota = rejected(service(request -> new DiagramPreviewService.ProviderReply(429,
        "{\"error\":{\"code\":\"insufficient_quota\"}}")), 503);
    assertTrue(quota.getReason().contains("额度"));
    for (String quotaBody : List.of(
        "{\"error\":{\"code\":\"credit_balance_exhausted\",\"type\":\"insufficient_quota\"}}",
        "{\"error\":{\"code\":\"credit_balance_exhausted\"}}",
        "{\"error\":{\"code\":\"other_billing_code\",\"type\":\"insufficient_quota\"}}",
        "{\"error\":{\"code\":\"billing_hard_limit_reached\"}}")) {
      var exhausted = rejected(service(request -> new DiagramPreviewService.ProviderReply(429, quotaBody)), 503);
      assertTrue(exhausted.getReason().contains("额度"));
      assertFalse(exhausted.getReason().contains("稍后再试"));
    }
    var rate = rejected(service(request -> new DiagramPreviewService.ProviderReply(429,
        "{\"error\":{\"code\":\"rate_limit_exceeded\"}}")), 429);
    assertTrue(rate.getReason().contains("请求较多"));
  }

  @Test
  void networkFailuresTimeoutAndInterruptedRequestsAreNotRetried() {
    AtomicInteger calls = new AtomicInteger();
    rejected(service(request -> { calls.incrementAndGet(); throw new IOException("private body"); }), 502);
    assertEquals(1, calls.get());
    rejected(service(request -> { throw new HttpTimeoutException("private request"); }), 504);
    try {
      rejected(service(request -> { throw new InterruptedException("private request"); }), 503);
      assertTrue(Thread.currentThread().isInterrupted());
    } finally { Thread.interrupted(); }
  }

  @Test
  void simultaneousRequestsForOneOrganizationAreBlockedAndReleaseAfterCompletion() throws Exception {
    CountDownLatch started = new CountDownLatch(1), finish = new CountDownLatch(1);
    var service = service(request -> {
      started.countDown();
      assertTrue(finish.await(5, TimeUnit.SECONDS));
      return new DiagramPreviewService.ProviderReply(200, response(diagram()));
    });
    UUID org = UUID.randomUUID();
    try (ExecutorService pool = Executors.newSingleThreadExecutor()) {
      Future<?> first = pool.submit(() -> service.preview(org, source));
      assertTrue(started.await(2, TimeUnit.SECONDS));
      var error = assertThrows(ResponseStatusException.class, () -> service.preview(org, source));
      assertEquals(409, error.getStatusCode().value());
      finish.countDown();
      first.get(3, TimeUnit.SECONDS);
      assertNotNull(service.preview(org, source));
    } finally { finish.countDown(); }
  }

  @Test
  void conservativeRateLimitAppliesPerOrganizationAndFailuresStillCount() {
    AtomicInteger calls = new AtomicInteger();
    var service = service(request -> { calls.incrementAndGet(); throw new IOException(); });
    UUID org = UUID.randomUUID();
    for (int i = 0; i < 3; i++) assertThrows(ResponseStatusException.class, () -> service.preview(org, source));
    var error = assertThrows(ResponseStatusException.class, () -> service.preview(org, source));
    assertEquals(429, error.getStatusCode().value());
    rejected(service, 502);
    assertEquals(4, calls.get());
  }

  @Test
  void responseSubscriberRejectsOversizedBodyBeforeKeepingItInMemory() {
    var subscriber = new DiagramPreviewService.BoundedBodySubscriber();
    AtomicBoolean cancelled = new AtomicBoolean();
    subscriber.onSubscribe(new Flow.Subscription() {
      public void request(long count) {}
      public void cancel() { cancelled.set(true); }
    });
    subscriber.onNext(List.of(ByteBuffer.wrap(new byte[DiagramPreviewService.MAX_RESPONSE_BYTES + 1])));
    assertTrue(cancelled.get());
    assertThrows(CompletionException.class, () -> subscriber.getBody().toCompletableFuture().join());
  }
}
