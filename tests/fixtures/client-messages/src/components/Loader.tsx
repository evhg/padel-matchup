"use client";
import { lazy } from "react";

// The path is built at run time, so no walk can know that it loads ./steps/Step.tsx.
export const byName = (name: string) => lazy(() => import(`./steps/${name}`).then((m) => ({ default: m.Step })));

// A local path that names no file: whatever stood there would load with nobody reading its keys.
// @ts-expect-error the module does not exist, on purpose
export const gone = () => import("./steps/Gone");
