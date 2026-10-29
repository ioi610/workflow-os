import { ArrowRight, BookOpen, ListOrdered, NotebookPen } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button } from "../../components/ui";
export function Auth({ onDone }: { onDone: () => void }) {
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth">
      <section>
        <a className="brand">
          <img src="/icon.svg" />
          WorkFlow OS
        </a>
        <div className="eyebrow">把工作记清楚</div>
        <h1>
          好工作，
          <br />
          从清楚的做法开始。
        </h1>
        <p>
          记录工作的顺序，写下每件事的做法。
          <br />
          需要的时候，打开页面就能找到。
        </p>
        <div className="auth-grid">
          {[ListOrdered, NotebookPen, BookOpen].map((I, i) => (
            <div key={i}>
              <I />
              <strong>
                {["记录工作流程", "写清具体做法", "随时打开查阅"][i]}
              </strong>
            </div>
          ))}
        </div>
      </section>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const f = new FormData(e.currentTarget);
          try {
            await api(
              `/auth/${register ? "register" : "login"}`,
              Object.fromEntries(f),
            );
            onDone();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2>{register ? "创建账号" : "欢迎回来"}</h2>
        <p>
          {register
            ? "把熟悉的工作和做法记下来，随时查看。"
            : "登录后，打开你的工作流程与操作说明。"}
        </p>
        {register && (
          <label>
            你的姓名
            <input name="displayName" required autoComplete="name" />
          </label>
        )}
        <label>
          邮箱
          <input name="email" type="email" required autoComplete="email" />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            minLength={10}
            maxLength={72}
            required
            autoComplete={register ? "new-password" : "current-password"}
          />
          <small>至少 10 位</small>
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <Button disabled={busy} type="submit">
          {busy ? "请稍候…" : register ? "创建账号" : "打开我的工作"}
          <ArrowRight size={17} />
        </Button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setRegister(!register);
            setError("");
          }}
        >
          {register ? "已有账号？登录" : "第一次使用？创建账号"}
        </button>
      </form>
    </div>
  );
}
