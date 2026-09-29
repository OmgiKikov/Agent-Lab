import { createBrowserRouter, Navigate } from "react-router-dom";
import { LabPage } from "./pages/LabPage";

export const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/lab" replace /> },
  { path: "/lab", element: <LabPage /> },
  { path: "/lab/:step", element: <LabPage /> },
  { path: "/lab/:step/:itemId", element: <LabPage /> },
  { path: "*", element: <Navigate to="/lab" replace /> },
]);
