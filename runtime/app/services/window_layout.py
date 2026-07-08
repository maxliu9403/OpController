from __future__ import annotations

import asyncio
import ctypes
import logging
import math
import platform
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any, Protocol

from app.config import settings


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScreenBounds:
    left: int
    top: int
    right: int
    bottom: int

    @property
    def width(self) -> int:
        return max(1, self.right - self.left)

    @property
    def height(self) -> int:
        return max(1, self.bottom - self.top)

    def as_tuple(self) -> tuple[int, int, int, int]:
        return self.left, self.top, self.right, self.bottom


@dataclass(frozen=True)
class WindowRect:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class SlotWindow:
    slot_index: int
    pid: int


@dataclass(frozen=True)
class SlotLayoutPlan:
    slot_limit: int
    columns: int
    rows: int
    rects: dict[int, WindowRect]


class WindowLayoutDriver(Protocol):
    async def read_screen_bounds(self) -> ScreenBounds | None:
        ...

    async def arrange(
        self,
        *,
        windows: list[SlotWindow],
        slot_limit: int,
        runtime_policy: dict[str, Any],
        screen_bounds: ScreenBounds | None,
    ) -> None:
        ...


class SlotLayoutCalculator:
    @classmethod
    def build_plan(
        cls,
        *,
        slot_limit: int,
        runtime_policy: dict[str, Any] | None = None,
        screen_bounds: ScreenBounds | None = None,
    ) -> SlotLayoutPlan:
        limit = max(1, slot_limit)
        runtime_policy = runtime_policy or {}
        bounds = screen_bounds or ScreenBounds(left=0, top=0, right=1440, bottom=900)
        columns, rows = cls.grid_for_slots(limit, bounds)
        margin = max(0, settings.window_layout_margin_px)
        usable_width = max(1, bounds.width - margin * (columns + 1))
        usable_height = max(
            1,
            bounds.height
            - settings.window_layout_top_offset_px
            - settings.window_layout_bottom_reserved_px
            - margin * (rows + 1),
        )
        cell_width = max(1, int(usable_width / columns))
        cell_height = max(1, int(usable_height / rows))
        preferred_width = max(
            settings.window_layout_min_width,
            int(runtime_policy.get("min_window_width") or settings.window_layout_default_width),
        )
        preferred_height = max(
            settings.window_layout_min_height,
            int(runtime_policy.get("min_window_height") or settings.window_layout_default_height),
        )
        width = cls._fit_dimension(cell_width, preferred_width, settings.window_layout_min_width)
        height = cls._fit_dimension(cell_height, preferred_height, settings.window_layout_min_height)
        rects: dict[int, WindowRect] = {}
        for slot_index in range(limit):
            column = slot_index % columns
            row = slot_index // columns
            rects[slot_index] = WindowRect(
                x=int(bounds.left + margin + column * (cell_width + margin)),
                y=int(bounds.top + settings.window_layout_top_offset_px + margin + row * (cell_height + margin)),
                width=int(width),
                height=int(height),
            )
        return SlotLayoutPlan(slot_limit=limit, columns=columns, rows=rows, rects=rects)

    @staticmethod
    def grid_for_slots(slot_limit: int, screen_bounds: ScreenBounds | None = None) -> tuple[int, int]:
        limit = max(1, slot_limit)
        bounds = screen_bounds or ScreenBounds(left=0, top=0, right=1440, bottom=900)
        target_aspect = max(0.5, min(3.5, bounds.width / bounds.height))
        best_columns = 1
        best_rows = limit
        best_score = float("inf")
        for columns in range(1, limit + 1):
            rows = math.ceil(limit / columns)
            empty_slots = columns * rows - limit
            grid_aspect = columns / rows
            score = abs(grid_aspect - target_aspect) + empty_slots * 0.08 + rows * 0.015
            if score < best_score:
                best_score = score
                best_columns = columns
                best_rows = rows
        return best_columns, best_rows

    @staticmethod
    def provider_tile_payload(
        *,
        active_count: int,
        slot_limit: int,
        runtime_policy: dict[str, Any],
        screen_bounds: ScreenBounds | None,
    ) -> dict[str, int]:
        plan = SlotLayoutCalculator.build_plan(
            slot_limit=max(active_count, slot_limit),
            runtime_policy=runtime_policy,
            screen_bounds=screen_bounds,
        )
        first_rect = plan.rects[0]
        return {
            "screen": settings.window_layout_screen_index,
            "layout": 1,
            "adaptive": 1,
            "starting_position_x": first_rect.x,
            "starting_position_y": first_rect.y,
            "profile_size_width": first_rect.width,
            "profile_size_hight": first_rect.height,
            "profile_spacing_horizontal": settings.window_layout_margin_px,
            "profile_spacing_vertical": settings.window_layout_margin_px,
            "profile_deviaton_x": 0,
            "profile_deviaton_y": 0,
            "per_line_number_of_profiles": plan.columns,
        }

    @staticmethod
    def estimate_capacity(screen_bounds: ScreenBounds | None) -> int:
        if not screen_bounds:
            return settings.max_slot_limit
        margin = max(0, settings.window_layout_margin_px)
        usable_width = max(1, screen_bounds.width - margin)
        usable_height = max(
            1,
            screen_bounds.height
            - settings.window_layout_top_offset_px
            - settings.window_layout_bottom_reserved_px
            - margin,
        )
        columns = max(1, usable_width // (settings.window_layout_min_width + margin))
        rows = max(1, usable_height // (settings.window_layout_min_height + margin))
        return max(1, min(settings.max_slot_limit, int(columns * rows)))

    @staticmethod
    def _fit_dimension(cell_size: int, preferred_size: int, min_size: int) -> int:
        if cell_size < min_size:
            return max(1, cell_size)
        return max(min_size, min(preferred_size, cell_size))


class NoopWindowLayoutDriver:
    async def read_screen_bounds(self) -> ScreenBounds | None:
        return None

    async def arrange(
        self,
        *,
        windows: list[SlotWindow],
        slot_limit: int,
        runtime_policy: dict[str, Any],
        screen_bounds: ScreenBounds | None,
    ) -> None:
        return None


class MacOsWindowLayoutDriver:
    async def read_screen_bounds(self) -> ScreenBounds | None:
        try:
            result = await asyncio.to_thread(
                subprocess.run,
                ["osascript", "-e", 'tell application "Finder" to get bounds of window of desktop'],
                capture_output=True,
                text=True,
                timeout=settings.window_layout_timeout_sec,
                check=False,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("failed to read macos screen bounds", extra={"error": str(exc)})
            return None
        if result.returncode != 0:
            logger.warning(
                "read macos screen bounds returned non-zero status",
                extra={"returncode": result.returncode, "stderr": result.stderr.strip()},
            )
            return None
        numbers = [int(item) for item in re.findall(r"-?\d+", result.stdout)]
        if len(numbers) < 4:
            return None
        left, top, right, bottom = numbers[:4]
        if right <= left or bottom <= top:
            return None
        return ScreenBounds(left=left, top=top, right=right, bottom=bottom)

    async def arrange(
        self,
        *,
        windows: list[SlotWindow],
        slot_limit: int,
        runtime_policy: dict[str, Any],
        screen_bounds: ScreenBounds | None,
    ) -> None:
        windows = [window for window in windows if window.pid > 0 and 0 <= window.slot_index < slot_limit]
        if not windows:
            return
        plan = SlotLayoutCalculator.build_plan(
            slot_limit=slot_limit,
            runtime_policy=runtime_policy,
            screen_bounds=screen_bounds,
        )
        script = self.build_script(windows=windows, plan=plan)
        result = await asyncio.to_thread(
            subprocess.run,
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=settings.window_layout_timeout_sec,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "macOS window layout script failed")

    @staticmethod
    def build_script(*, windows: list[SlotWindow], plan: SlotLayoutPlan) -> str:
        pid_list = ", ".join(str(window.pid) for window in windows)
        position_list = ", ".join(
            "{{{0}, {1}}}".format(plan.rects[window.slot_index].x, plan.rects[window.slot_index].y)
            for window in windows
        )
        size_list = ", ".join(
            "{{{0}, {1}}}".format(plan.rects[window.slot_index].width, plan.rects[window.slot_index].height)
            for window in windows
        )
        return f"""
set targetPids to {{{pid_list}}}
set targetPositions to {{{position_list}}}
set targetSizes to {{{size_list}}}
tell application "System Events"
  repeat with p in processes
    try
      set pidValue to unix id of p
      repeat with targetIndex from 1 to count of targetPids
        if item targetIndex of targetPids is pidValue then
          if (count of windows of p) > 0 then
            set targetWindow to item 1 of windows of p
            set position of targetWindow to item targetIndex of targetPositions
            set size of targetWindow to item targetIndex of targetSizes
          end if
        end if
      end repeat
    end try
  end repeat
end tell
"""


class WindowsWindowLayoutDriver:
    async def read_screen_bounds(self) -> ScreenBounds | None:
        try:
            user32 = ctypes.windll.user32  # type: ignore[attr-defined]
            left = int(user32.GetSystemMetrics(76))
            top = int(user32.GetSystemMetrics(77))
            width = int(user32.GetSystemMetrics(78))
            height = int(user32.GetSystemMetrics(79))
            if width <= 0 or height <= 0:
                left = 0
                top = 0
                width = int(user32.GetSystemMetrics(0))
                height = int(user32.GetSystemMetrics(1))
            return ScreenBounds(left=left, top=top, right=left + width, bottom=top + height)
        except Exception as exc:  # noqa: BLE001
            logger.warning("failed to read windows screen bounds", extra={"error": str(exc)})
            return None

    async def arrange(
        self,
        *,
        windows: list[SlotWindow],
        slot_limit: int,
        runtime_policy: dict[str, Any],
        screen_bounds: ScreenBounds | None,
    ) -> None:
        windows = [window for window in windows if window.pid > 0 and 0 <= window.slot_index < slot_limit]
        if not windows:
            return
        plan = SlotLayoutCalculator.build_plan(
            slot_limit=slot_limit,
            runtime_policy=runtime_policy,
            screen_bounds=screen_bounds,
        )
        script = self.build_script(windows=windows, plan=plan)
        executable = shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh")
        if not executable:
            raise RuntimeError("PowerShell is required for Windows window layout")
        result = await asyncio.to_thread(
            subprocess.run,
            [executable, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            timeout=settings.window_layout_timeout_sec,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "Windows window layout script failed")

    @staticmethod
    def build_script(*, windows: list[SlotWindow], plan: SlotLayoutPlan) -> str:
        rows = []
        for window in windows:
            rect = plan.rects[window.slot_index]
            rows.append(
                f"[pscustomobject]@{{ Pid = {window.pid}; X = {rect.x}; Y = {rect.y}; W = {rect.width}; H = {rect.height} }}"
            )
        window_rows = ",\n  ".join(rows)
        return f"""
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class WinLayout {{
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, UInt32 uFlags);
}}
"@
$targets = @(
  {window_rows}
)
$handles = @{{}}
$callback = [WinLayout+EnumWindowsProc]{{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if (-not [WinLayout]::IsWindowVisible($hWnd)) {{ return $true }}
  [uint32]$pid = 0
  [void][WinLayout]::GetWindowThreadProcessId($hWnd, [ref]$pid)
  if ($pid -gt 0 -and -not $handles.ContainsKey([int]$pid)) {{
    $handles[[int]$pid] = $hWnd
  }}
  return $true
}}
[WinLayout]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
foreach ($target in $targets) {{
  $handle = $handles[[int]$target.Pid]
  if ($null -ne $handle) {{
    [void][WinLayout]::ShowWindow($handle, 9)
    [void][WinLayout]::SetWindowPos($handle, [IntPtr]::Zero, [int]$target.X, [int]$target.Y, [int]$target.W, [int]$target.H, 0x0014)
  }}
}}
"""


def get_window_layout_driver() -> WindowLayoutDriver:
    system = platform.system()
    if system == "Darwin":
        return MacOsWindowLayoutDriver()
    if system == "Windows":
        return WindowsWindowLayoutDriver()
    return NoopWindowLayoutDriver()
