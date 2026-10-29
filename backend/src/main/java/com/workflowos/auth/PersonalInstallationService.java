package com.workflowos.auth;

import com.workflowos.Model.*;
import jakarta.persistence.*;
import java.util.*;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PersonalInstallationService {
  @PersistenceContext EntityManager em;
  private final BCryptPasswordEncoder encoder;

  public PersonalInstallationService(BCryptPasswordEncoder encoder) {
    this.encoder = encoder;
  }

  @Transactional
  public Map<String, Object> bootstrap(UUID authenticatedUser, UUID hintedOrganization) {
    // The migration seeds this singleton before any request. This lock serializes first use
    // across sessions and processes; its foreign keys keep the pinned identity durable.
    PersonalInstallation installation =
        em.find(PersonalInstallation.class, 1, LockModeType.PESSIMISTIC_WRITE);
    if (installation.ownerUserId == null) {
      Account owner = authenticatedUser == null ? null : em.find(Account.class, authenticatedUser);
      Organization organization = null;
      if (owner != null) {
        List<Member> memberships = memberships(owner.id);
        // An existing session always takes precedence over a hint belonging to someone else.
        Member existing = memberships.stream()
            .filter(m -> m.organizationId.equals(hintedOrganization))
            .findFirst()
            .orElseGet(() -> memberships.stream()
                .filter(m -> "OWNER".equals(m.role))
                .findFirst()
                .orElse(null));
        if (existing != null) organization = em.find(Organization.class, existing.organizationId);
      } else if (hintedOrganization != null) {
        Member existing = em.createQuery(
                "from Member where organizationId=:o and role='OWNER' and status='ACTIVE' order by createdAt, id",
                Member.class)
            .setParameter("o", hintedOrganization)
            .getResultStream()
            .findFirst()
            .orElse(null);
        if (existing != null) {
          owner = em.find(Account.class, existing.userId);
          organization = em.find(Organization.class, existing.organizationId);
        }
      }
      if (owner == null) {
        owner = new Account();
        owner.email = UUID.randomUUID() + "@local.invalid";
        // No usable password is stored or exposed: the random source is discarded immediately.
        owner.passwordHash = encoder.encode(UUID.randomUUID().toString() + UUID.randomUUID());
        owner.displayName = "本机用户";
        em.persist(owner);
      }
      if (organization == null) {
        organization = new Organization();
        organization.name = "我的工作手册";
        em.persist(organization);
        Member membership = new Member();
        membership.organizationId = organization.id;
        membership.userId = owner.id;
        membership.role = "OWNER";
        em.persist(membership);
      }
      installation.ownerUserId = owner.id;
      installation.defaultOrganizationId = organization.id;
    }
    // Later calls cannot retarget the installation, including calls with another login session.
    List<Member> memberships = memberships(installation.ownerUserId);
    return Map.of(
        "user", em.find(Account.class, installation.ownerUserId),
        "memberships", memberships,
        "organizations", memberships.stream()
            .map(m -> em.find(Organization.class, m.organizationId)).toList(),
        "personalMode", true,
        "defaultOrganizationId", installation.defaultOrganizationId);
  }

  private List<Member> memberships(UUID userId) {
    return em.createQuery(
            "from Member where userId=:u and status='ACTIVE' order by createdAt, id", Member.class)
        .setParameter("u", userId)
        .getResultList();
  }
}
