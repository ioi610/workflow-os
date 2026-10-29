package com.workflowos;

import com.workflowos.Model.*;
import jakarta.persistence.*;
import jakarta.servlet.http.HttpSession;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

@Component
public class Access {
  @PersistenceContext EntityManager em;

  public UUID user(HttpSession s) {
    Object id = s.getAttribute("userId");
    if (id == null) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "页面已失效，请刷新后再试");
    return (UUID) id;
  }

  public Member member(UUID org, HttpSession s, boolean manage) {
    UUID uid = user(s);
    Member m =
        em.createQuery(
                "from Member where organizationId=:o and userId=:u and status='ACTIVE'",
                Member.class)
            .setParameter("o", org)
            .setParameter("u", uid)
            .getResultStream()
            .findFirst()
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.FORBIDDEN, "你暂时不能查看或修改这里的内容"));
    if (manage && m.role.equals("EMPLOYEE"))
      throw new ResponseStatusException(HttpStatus.FORBIDDEN, "你暂时不能查看或修改这里的内容");
    return m;
  }

  public <T extends Tenant> T get(Class<T> type, UUID id, UUID org) {
    T item = em.find(type, id);
    if (item == null || !item.organizationId.equals(org))
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有找到这项内容");
    return item;
  }

  public <T extends Tenant> List<T> list(Class<T> type, UUID org) {
    return em.createQuery(
            "from " + type.getSimpleName() + " where organizationId=:o order by createdAt", type)
        .setParameter("o", org)
        .getResultList();
  }

  public void audit(UUID org, UUID user, String action, UUID resource, String details) {
    Audit a = new Audit();
    a.organizationId = org;
    a.actorId = user;
    a.action = action;
    a.resourceId = resource;
    a.details = details;
    em.persist(a);
  }
}
