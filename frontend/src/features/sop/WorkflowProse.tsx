export function WorkflowProse({ paragraphs }: { paragraphs: string[] }) {
  return (
    <article className="complete-prose" aria-label="完整流程正文">
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </article>
  );
}
