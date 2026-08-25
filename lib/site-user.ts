import { redirect } from "next/navigation";

import {
  chatGPTSignInPath,
  getChatGPTUser,
  type ChatGPTUser,
} from "@/app/chatgpt-auth";

const LOCAL_USER: ChatGPTUser = {
  userId: "local-preview-user",
  displayName: "本地预览",
  email: "local-preview@example.invalid",
  fullName: "本地预览",
};

export async function requireSiteUser(returnTo: string): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;
  if (process.env.NODE_ENV !== "production") return LOCAL_USER;
  redirect(chatGPTSignInPath(returnTo));
}
