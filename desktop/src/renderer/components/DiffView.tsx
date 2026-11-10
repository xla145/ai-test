/** 统一 diff 展示（自愈修改建议） */
export function DiffView({ diff }: { diff: string }) {
  return (
    <div className="diff">
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("@@") ? "diff-hunk" : line.startsWith("+") && !line.startsWith("+++") ? "diff-add"
          : line.startsWith("-") && !line.startsWith("---") ? "diff-del" : "";
        return <div key={i} className={`diff-line ${cls}`}>{line || " "}</div>;
      })}
    </div>
  );
}
