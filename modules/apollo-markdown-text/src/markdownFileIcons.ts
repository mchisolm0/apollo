import { Image, type ImageSourcePropType } from "react-native";

import type { MarkdownFileIcon } from "./markdownLinks";
import { MARKDOWN_FILE_ICON_SOURCES } from "./markdownFileIcons.generated";

export function markdownFileIconSource(icon: MarkdownFileIcon): ImageSourcePropType {
  return MARKDOWN_FILE_ICON_SOURCES[icon];
}

/** Bundled icon URI for native views that draw the icon themselves. Undefined means no icon. */
export function markdownIconAssetUri(source: ImageSourcePropType): string | undefined {
  return Image.resolveAssetSource(source)?.uri;
}
