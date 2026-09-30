import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button, Label } from "./ui";

/** The way on from a setup step: what the next step gives, and one button to it. */
export function NextStep({ title, hint, to, cta, done, onClick }: { title: string; hint: string; to: string; cta: string; done?: boolean; onClick?: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="mt-12 flex flex-wrap items-center gap-4 border-t border-lab-line pt-5">
      <div className="min-w-0 flex-1">
        <Label>{done ? "Следующий шаг уже пройден" : "Дальше"}</Label>
        <div className="mt-1 text-reading text-lab-ink">{title}</div>
        <div className="text-body text-lab-mute">{hint}</div>
      </div>
      <Button variant={done ? "secondary" : "primary"} onClick={onClick ?? (() => navigate(to))}>{cta}<ArrowRight className="size-3.5" /></Button>
    </div>
  );
}
