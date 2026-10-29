package com.workflowos;

import static com.workflowos.common.Errors.require;

import com.workflowos.Model.*;
import jakarta.persistence.*;
import jakarta.servlet.http.HttpSession;
import java.time.Instant;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/orgs/{org}/work-items")
@Transactional
public class WorkItemController {
  @PersistenceContext EntityManager em;
  final Access access;
  final WorkItemRegistry registry;

  public WorkItemController(Access access, WorkItemRegistry registry) {
    this.access = access;
    this.registry = registry;
  }

  @GetMapping
  public List<WorkItem> list(@PathVariable UUID org, HttpSession session) {
    access.member(org, session, false);
    return registry.list(org);
  }

  public record NotesInput(String notes) {}

  @PutMapping("/{id}")
  public WorkItem edit(
      @PathVariable UUID org,
      @PathVariable UUID id,
      @RequestBody NotesInput input,
      HttpSession session) {
    access.member(org, session, true);
    require(input.notes != null && input.notes.length() <= 20000, "工作备注最多能写 20000 个字");
    UUID workflowId =
        em.createQuery(
                "select workflowId from WorkItem where id=:id and organizationId=:org", UUID.class)
            .setParameter("id", id)
            .setParameter("org", org)
            .getResultStream()
            .findFirst()
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "没有找到这项工作"));
    Sop workflow = access.get(Sop.class, workflowId, org);
    em.lock(workflow, LockModeType.PESSIMISTIC_WRITE);
    if (workflow.status.equals("ARCHIVED"))
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "这项工作所在的流程暂时不能修改");
    WorkItem item =
        em.createQuery("from WorkItem where id=:id and organizationId=:org", WorkItem.class)
            .setParameter("id", id)
            .setParameter("org", org)
            .setLockMode(LockModeType.PESSIMISTIC_WRITE)
            .getResultStream()
            .findFirst()
            .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "没有找到这项工作"));
    if (!Objects.equals(item.notes, input.notes)) {
      item.notes = input.notes;
      item.updatedAt = Instant.now();
      access.audit(org, access.user(session), "WORK_ITEM_NOTES_EDIT", id, "");
    }
    em.flush();
    return item;
  }
}
