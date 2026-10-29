package com.workflowos;

import static com.workflowos.common.Errors.require;

import com.workflowos.Model.*;
import jakarta.persistence.*;
import jakarta.servlet.http.HttpSession;
import java.nio.file.*;
import java.util.*;
import javax.imageio.ImageIO;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.*;
import org.springframework.http.*;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/orgs/{org}/files")
@Transactional
public class MediaController {
  @PersistenceContext EntityManager em;
  final Access a;
  final Path root;

  public MediaController(Access a, @Value("${workflow.media-dir:./.data/media}") String path) {
    this.a = a;
    root = Path.of(path).toAbsolutePath().normalize();
  }

  @PostMapping(consumes = "multipart/form-data")
  public Map<String, Object> upload(
      @PathVariable UUID org, @RequestParam MultipartFile file, HttpSession session)
      throws Exception {
    a.member(org, session, false);
    require(!file.isEmpty() && file.getSize() <= 5 * 1024 * 1024, "图片不能超过 5 MB");
    byte[] data = file.getBytes();
    String type =
        data.length >= 8 && data[0] == (byte) 137 && data[1] == 80 && data[2] == 78 && data[3] == 71
            ? "image/png"
            : data.length > 3
                    && data[0] == (byte) 255
                    && data[1] == (byte) 216
                    && data[2] == (byte) 255
                ? "image/jpeg"
                : null;
    require(type != null, "请使用 PNG 或 JPG 格式的图片");
    try (var stream = ImageIO.createImageInputStream(new java.io.ByteArrayInputStream(data))) {
      var readers = ImageIO.getImageReaders(stream);
      require(readers.hasNext(), "这张图片打不开，请换一张再试");
      var reader = readers.next();
      try {
        reader.setInput(stream);
        require((long) reader.getWidth(0) * reader.getHeight(0) <= 40_000_000, "这张图片太大，请缩小后再上传");
      } finally {
        reader.dispose();
      }
    }
    Media m = new Media();
    m.organizationId = org;
    m.uploadedBy = a.user(session);
    m.contentType = type;
    m.byteSize = data.length;
    em.persist(m);
    em.flush();
    Files.createDirectories(root.resolve(org.toString()));
    Files.write(
        root.resolve(org.toString()).resolve(m.id.toString()), data, StandardOpenOption.CREATE_NEW);
    return Map.of("id", m.id, "url", "/api/orgs/" + org + "/files/" + m.id);
  }

  @GetMapping("/{id}")
  public ResponseEntity<Resource> get(
      @PathVariable UUID org, @PathVariable UUID id, HttpSession s) {
    a.member(org, s, false);
    Media m = a.get(Media.class, id, org);
    Resource file = new FileSystemResource(root.resolve(org.toString()).resolve(id.toString()));
    return ResponseEntity.ok()
        .contentType(MediaType.parseMediaType(m.contentType))
        .cacheControl(CacheControl.noStore())
        .header("Content-Disposition", "inline")
        .body(file);
  }
}
