import Link from "next/link";

import { logoutAction } from "@/app/auth-actions";
import { getCurrentUser } from "@/lib/auth";

export async function AccountMenu() {
  const user = await getCurrentUser();
  if (!user) return null;

  const label = user.name || user.username;
  return (
    <div className="accountMenu">
      <span className="accountAvatar" aria-hidden="true">{label.slice(0, 1)}</span>
      <div><strong>{label}</strong><small>@{user.username}</small></div>
      <Link href="/runner" title="本地 Runner 设置">Runner</Link>
      <form action={logoutAction}>
        <button type="submit" title="退出当前账号">退出登录</button>
      </form>
    </div>
  );
}
