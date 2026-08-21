import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./theme.css";
import { readTheme, applyTheme } from "./theme";

/* Before first paint, so there is no flash of the wrong palette. */
applyTheme(readTheme());

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
