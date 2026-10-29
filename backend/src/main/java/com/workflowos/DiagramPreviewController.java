package com.workflowos;

import jakarta.servlet.http.HttpSession;
import java.util.Map;
import java.util.UUID;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.*;

/** Extraction is a preview only. Saving a reviewed diagram uses the existing workflow save route. */
@RestController
@RequestMapping("/api/orgs/{org}/diagram-preview")
public class DiagramPreviewController {
  private final Access access;
  private final DiagramPreviewService diagrams;
  private final TransactionTemplate permissions;

  public DiagramPreviewController(Access access, DiagramPreviewService diagrams,
      PlatformTransactionManager transactions) {
    this.access = access;
    this.diagrams = diagrams;
    this.permissions = new TransactionTemplate(transactions);
    this.permissions.setReadOnly(true);
  }

  private void authorize(UUID org, HttpSession session) {
    // Complete the membership query before waiting on the provider; no database transaction is held.
    permissions.executeWithoutResult(ignored -> access.member(org, session, true));
  }

  @GetMapping
  public Map<String, Boolean> available(@PathVariable UUID org, HttpSession session) {
    authorize(org, session);
    return Map.of("available", diagrams.available());
  }

  public record TextInput(String text) {}

  @PostMapping
  public DiagramPreviewService.Diagram preview(
      @PathVariable UUID org, @RequestBody TextInput input, HttpSession session) {
    authorize(org, session);
    return diagrams.preview(org, input == null ? null : input.text());
  }
}
