package com.workflowos.auth;

import com.workflowos.Model.Account;
import jakarta.servlet.http.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class PersonalController {
  private final boolean personalMode;
  private final PersonalInstallationService installation;

  public PersonalController(
      @Value("${workflow.personal-mode:false}") boolean personalMode,
      PersonalInstallationService installation) {
    this.personalMode = personalMode;
    this.installation = installation;
  }

  public record BootstrapRequest(UUID organizationId) {}

  @GetMapping("/mode")
  public Map<String, Boolean> mode() {
    return Map.of("personalMode", personalMode);
  }

  @PostMapping("/personal/bootstrap")
  public Map<String, Object> bootstrap(
      @RequestBody(required = false) BootstrapRequest body, HttpServletRequest request) {
    if (!personalMode) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "个人模式未启用");
    HttpSession previous = request.getSession(false);
    UUID authenticatedUser =
        previous != null && previous.getAttribute("userId") instanceof UUID id ? id : null;
    Map<String, Object> profile =
        installation.bootstrap(authenticatedUser, body == null ? null : body.organizationId());
    // Set the session only after the installation transaction commits successfully.
    request.getSession();
    request.changeSessionId();
    request.getSession().setAttribute("userId", ((Account) profile.get("user")).id);
    return profile;
  }
}
