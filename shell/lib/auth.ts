import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { emailOTP, testUtils } from "better-auth/plugins";
import { admin as adminPlugin } from "better-auth/plugins";
import { prismadb } from "@/lib/prisma";
import { ac, admin, member, viewer } from "@/lib/auth-permissions";
import mailer from "@/lib/mail";
import { APIError } from "better-auth/api";
import { isAllowedSignupEmail } from "@/lib/security/signup-allowlist";

export const auth = betterAuth({
  // Sign-in codes are guessable if tries are unlimited: three sends and ten checks a minute for any one visitor.
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/email-otp/send-verification-otp": { window: 60, max: 3 },
      "/sign-in/email-otp": { window: 60, max: 10 },
    },
  },
  database: prismaAdapter(prismadb, { provider: "postgresql" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  advanced: {
    database: {
      generateId: "uuid",
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7,       // 7 days
    updateAge: 60 * 60 * 24,            // refresh every 24 hours
  },

  user: {
    modelName: "Users",
    fields: {
      createdAt: "created_on",
      updatedAt: "updated_at",
      image: "image",
    },
    additionalFields: {
      role: {
        type: "string",
        defaultValue: "member",
        input: false,
      },
      userStatus: {
        type: "string",
        defaultValue: "PENDING",
        input: false,
      },
      userLanguage: {
        type: "string",
        defaultValue: "en",
        input: false,
      },
      avatar: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_ID!,
      clientSecret: process.env.GOOGLE_SECRET!,
    },
  },

  emailAndPassword: {
    enabled: false,
  },

  plugins: [
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        // A code is only ever mailed to an address that may sign in: an allowed domain, or someone already in this CRM
        // (an admin can invite outside the domains). Any other address gets no mail and the same reply as a real one.
        const known = await prismadb.users.findUnique({ where: { email: String(email).toLowerCase() }, select: { id: true } });
        if (!known && !isAllowedSignupEmail(email)) return;
        try {
          const mail = await mailer({ signIn: true });
          await mail.emails.send({
            from: `${process.env.NEXT_PUBLIC_APP_NAME} <${process.env.EMAIL_FROM}>`,
            to: email,
            subject: `Your verification code: ${otp}`,
            text: `Your one-time verification code is: ${otp}\n\nThis code expires in 5 minutes.\n\nIf you did not request this, please ignore this email.`,
          });
        } catch (e) {
          // In dev/test, email sending may fail — OTP is captured by testUtils plugin
          if (process.env.NODE_ENV !== "production") {
            console.log(`[Auth] OTP email send failed for ${email}, but captured by testUtils`);
          } else {
            throw e;
          }
        }
      },
    }),
    // testUtils captures OTPs for E2E testing — only enabled in non-production
    ...(process.env.NODE_ENV !== "production" && process.env.ENABLE_TEST_OTP === "1"
      ? [testUtils({ captureOTP: true })]
      : []),
    adminPlugin({
      ac,
      roles: { admin, member, viewer },
      defaultRole: "member",
    }),
  ],

  account: {
    // Google access and refresh tokens are stored encrypted (BETTER_AUTH_SECRET), never in plain text.
    encryptOAuthTokens: true,
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Sign-in with Google or an emailed code creates the user on first use,
        // so this is the sign-up gate. Only allowed email domains get a row;
        // everyone else is refused before anything is written. New users still
        // land as PENDING and an admin still approves them.
        before: async (user) => {
          if (!isAllowedSignupEmail(user.email)) {
            throw new APIError("FORBIDDEN", {
              message: "Sign-up is limited to this business's email domains.",
            });
          }
          return { data: user };
        },
        // The first user to sign in becomes the admin; everyone after lands as
        // PENDING until an admin approves them.
        after: async (user) => {
          try {
            const count = await prismadb.users.count();
            if (count === 1) {
              await prismadb.users.update({
                where: { id: user.id },
                data: { role: "admin", userStatus: "ACTIVE" },
              });
            }
          } catch (e) {
            // The user row exists by now; a failed alert must not fail the sign-in.
            console.error("[auth] post-create hook failed", e);
          }
        },
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
