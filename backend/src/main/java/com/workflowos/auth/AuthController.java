package com.workflowos.auth;

import static com.workflowos.common.Errors.require;

import com.workflowos.*;
import com.workflowos.Access;
import com.workflowos.Model.*;
import jakarta.persistence.*;
import jakarta.servlet.http.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
@Transactional
public class AuthController {
  @PersistenceContext EntityManager em;
  private final BCryptPasswordEncoder encoder;
  private final Access access;

  public AuthController(BCryptPasswordEncoder e, Access a) {
    encoder = e;
    access = a;
  }

  public record Credentials(
      @Email @NotBlank String email,
      @Size(min = 10, max = 72) String password,
      String displayName) {}

  @GetMapping("/csrf")
  public Map<String, String> csrf(CsrfToken token) {
    return Map.of("token", token.getToken(), "headerName", token.getHeaderName());
  }

  @PostMapping("/auth/register")
  public Account register(@Valid @RequestBody Credentials c, HttpServletRequest req) {
    require(c.password() != null, "请输入密码");
    require(
        em.createQuery("select count(a) from Account a where email=:e", Long.class)
                .setParameter("e", c.email().trim().toLowerCase())
                .getSingleResult()
            == 0,
        "邮箱已被注册");
    Account a = new Account();
    a.email = c.email().trim().toLowerCase();
    a.passwordHash = encoder.encode(c.password());
    a.displayName = c.displayName() == null ? "新同事" : c.displayName();
    em.persist(a);
    req.getSession();
    req.changeSessionId();
    req.getSession().setAttribute("userId", a.id);
    return a;
  }

  @PostMapping("/auth/login")
  public Account login(@Valid @RequestBody Credentials c, HttpServletRequest req) {
    Account a =
        em.createQuery("from Account where email=:e", Account.class)
            .setParameter("e", c.email().trim().toLowerCase())
            .getResultStream()
            .findFirst()
            .orElse(null);
    if (a == null || c.password() == null || !encoder.matches(c.password(), a.passwordHash))
      throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "邮箱或密码错误");
    req.getSession();
    req.changeSessionId();
    req.getSession().setAttribute("userId", a.id);
    return a;
  }

  @PostMapping("/auth/logout")
  public void logout(HttpSession s) {
    s.invalidate();
  }

  @GetMapping("/auth/me")
  public Map<String, Object> me(HttpSession s) {
    UUID uid = access.user(s);
    var memberships =
        em.createQuery("from Member where userId=:u and status='ACTIVE'", Member.class)
            .setParameter("u", uid)
            .getResultList();
    return Map.of(
        "user",
        em.find(Account.class, uid),
        "memberships",
        memberships,
        "organizations",
        memberships.stream().map(m -> em.find(Organization.class, m.organizationId)).toList());
  }

  @PostMapping("/organizations")
  public Organization organization(@RequestBody Map<String, String> b, HttpSession s) {
    UUID uid = access.user(s);
    require(b.get("name") != null && !b.get("name").isBlank(), "请输入组织名称");
    Organization o = new Organization();
    o.name = b.get("name");
    em.persist(o);
    Member m = new Member();
    m.organizationId = o.id;
    m.userId = uid;
    m.role = "OWNER";
    em.persist(m);
    return o;
  }
}
