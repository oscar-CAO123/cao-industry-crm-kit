"use server";
import { getSession } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";
import { revalidatePath } from "next/cache";

export const updateProfile = async (data: {
  userId: string;
  name: string;
  username: string;
  account_name: string;
}) => {
  const session = await getSession();
  if (!session) return { error: "Unauthorized" };

  const clean = (v: string) => String(v ?? "").replace(/[\u0000-\u001f\u007f\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, "").trim().slice(0, 100);
  const userId = data.userId, name = clean(data.name), username = clean(data.username), account_name = clean(data.account_name);

  if (!userId) return { error: "userId is required" };

  // Ensure user can only update their own profile unless admin
  if (session.user.id !== userId && session.user.role !== "admin") {
    return { error: "Forbidden" };
  }

  try {
    const user = await prismadb.users.update({
      data: { name, username, account_name },
      where: { id: userId },
    });
    revalidatePath("/[locale]/(routes)/profile", "page");
    return { data: user };
  } catch (error) {
    console.log("[UPDATE_PROFILE]", error);
    return { error: "Failed to update profile" };
  }
};
