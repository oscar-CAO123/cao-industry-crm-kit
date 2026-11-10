import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/jest.env.setup.ts"],
  moduleNameMapper: {
    "^@prisma/client$": "<rootDir>/generated/prisma",
    "^@/(.*)$": "<rootDir>/$1",
  },
  testMatch: ["**/__tests__/**/*.test.ts", "**/__tests__/**/*.test.tsx"],
  transform: {
    // react-jsx (the automatic runtime), not the classic "react". App components
    // do not import React, because Next compiles them with the automatic runtime,
    // so the classic setting throws "React is not defined" the moment a test
    // actually RENDERS one. Backwards compatible: the automatic runtime works
    // whether or not a file imports React, and no other .tsx test exists.
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { jsx: "react-jsx", target: "es2017" } }],
  },
};

export default config;
