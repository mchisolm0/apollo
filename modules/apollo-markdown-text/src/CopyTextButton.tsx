import { SymbolView } from "expo-symbols";
import * as Clipboard from "expo-clipboard";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, Pressable, type ColorValue } from "react-native";

const COPY_FEEDBACK_DURATION_MS = 1200;

export const CopyTextButton = memo(function CopyTextButton(props: {
  readonly accessibilityLabel: string;
  readonly text: string;
  readonly tintColor: ColorValue;
  readonly copiedTintColor?: ColorValue;
  readonly backgroundColor?: ColorValue;
  readonly borderColor?: ColorValue;
  readonly iconSize?: number;
  readonly buttonSize?: number;
}) {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
    },
    [],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : props.accessibilityLabel}
      disabled={props.text.length === 0}
      onPress={() => {
        void Clipboard.setStringAsync(props.text).then(() => {
          if (!mountedRef.current) return;
          setCopied(true);
          if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
          resetTimeoutRef.current = setTimeout(() => {
            setCopied(false);
            resetTimeoutRef.current = null;
          }, COPY_FEEDBACK_DURATION_MS);
        }).catch(() => {
          if (mountedRef.current) Alert.alert("Could not copy", "Try selecting and copying the code instead.");
        });
      }}
      style={({ pressed }) => ({
        width: props.buttonSize ?? 44,
        height: props.buttonSize ?? 44,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        borderWidth: props.borderColor ? 1 : 0,
        borderColor: props.borderColor,
        backgroundColor: props.backgroundColor,
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name={copied ? "checkmark" : "doc.on.doc"}
        size={props.iconSize ?? 13}
        tintColor={copied ? (props.copiedTintColor ?? props.tintColor) : props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
});
