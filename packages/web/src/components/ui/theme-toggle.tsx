"use client";

import { useTheme } from "../../theme/theme-provider";

type ThemeToggleProps = {
  onSelect?: () => void;
};

export function ThemeToggle({ onSelect }: ThemeToggleProps) {
  const { theme, setTheme, themes } = useTheme();

  return (
    <div className="theme-toggle">
      {themes.map((option) => (
        <button
          key={option.id}
          type="button"
          data-active={theme === option.id}
          onClick={() => {
            setTheme(option.id);
            onSelect?.();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
