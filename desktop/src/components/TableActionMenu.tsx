import { Button, Dropdown, Space } from "antd";
import type { MenuProps } from "antd";
import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";

export type TableActionItem = {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
};

type TableActionMenuProps = {
  primary?: TableActionItem | null;
  actions?: TableActionItem[];
  loading?: boolean;
};

export function TableActionMenu({ primary, actions = [], loading }: TableActionMenuProps) {
  const enabledActions = actions.filter(Boolean);
  const menuItems: MenuProps["items"] = enabledActions.map((action) => ({
    key: action.key,
    label: action.label,
    icon: action.icon,
    danger: action.danger,
    disabled: action.disabled,
    onClick: action.onClick,
  }));

  return (
    <Space size={6} className="table-action-menu">
      {primary ? (
        <Button
          size="small"
          type="primary"
          danger={primary.danger}
          icon={primary.icon}
          loading={loading}
          disabled={primary.disabled}
          onClick={primary.onClick}
        >
          {primary.label}
        </Button>
      ) : null}
      {menuItems.length ? (
        <Dropdown menu={{ items: menuItems }} trigger={["click"]}>
          <Button size="small" icon={<MoreHorizontal size={14} />} />
        </Dropdown>
      ) : null}
    </Space>
  );
}
