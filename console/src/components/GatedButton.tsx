import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMe } from "@/lib/auth";
import { denyReason, type Capability } from "@/lib/roles";

interface Props extends ComponentProps<typeof Button> {
  /** Role capability required (mirrors the server). */
  cap?: Capability;
  /** Any additional reason this action is unavailable right now (e.g. separation of duties). */
  blockReason?: string | null;
}

/**
 * A button that is really disabled - not merely hidden - when the operator's role (or the situation) does not
 * allow the action, and says why on hover. The server enforces the same rule regardless.
 */
export function GatedButton({ cap, blockReason, disabled, children, ...rest }: Props) {
  const me = useMe();
  const reason = blockReason ?? (cap ? denyReason(me.roles, cap) : null);
  if (!reason) {
    return (
      <Button disabled={disabled} {...rest}>
        {children}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-block" data-blocked-reason={reason}>
          <Button disabled {...rest} className={rest.className}>
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason}</TooltipContent>
    </Tooltip>
  );
}
