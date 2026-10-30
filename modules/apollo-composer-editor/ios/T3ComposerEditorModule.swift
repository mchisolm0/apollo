import ExpoModulesCore
import UIKit

public class T3ComposerEditorModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3ComposerEditor")

    View(T3ComposerEditorView.self) {
      Prop("controlledDocumentJson") { (view: T3ComposerEditorView, documentJson: String) in
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { (view: T3ComposerEditorView, themeJson: String) in
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { (view: T3ComposerEditorView, placeholder: String) in
        view.setPlaceholder(placeholder)
      }
      // On the text view itself: a label on the container would make it one opaque element.
      Prop("textAccessibilityLabel") { (view: T3ComposerEditorView, label: String) in
        view.setTextAccessibility(label: label, hint: nil)
      }
      Prop("textAccessibilityHint") { (view: T3ComposerEditorView, hint: String) in
        view.setTextAccessibility(label: nil, hint: hint)
      }
      Prop("fontFamily") { (view: T3ComposerEditorView, fontFamily: String) in
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { (view: T3ComposerEditorView, fontSize: Double) in
        view.setFontSize(CGFloat(fontSize))
      }
      Prop("lineHeight") { (view: T3ComposerEditorView, lineHeight: Double) in
        view.setLineHeight(CGFloat(lineHeight))
      }
      Prop("contentInsetVertical") { (view: T3ComposerEditorView, contentInsetVertical: Double) in
        view.setContentInsetVertical(CGFloat(contentInsetVertical))
      }
      Prop("editable") { (view: T3ComposerEditorView, editable: Bool) in
        view.setEditable(editable)
      }
      Prop("readOnly") { (view: T3ComposerEditorView, readOnly: Bool) in
        view.setReadOnly(readOnly)
      }
      Prop("scrollEnabled") { (view: T3ComposerEditorView, scrollEnabled: Bool) in
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { (view: T3ComposerEditorView, autoFocus: Bool) in
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { (view: T3ComposerEditorView, autoCorrect: Bool) in
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { (view: T3ComposerEditorView, spellCheck: Bool) in
        view.setSpellCheck(spellCheck)
      }
      Prop("enterBehavior") { (view: T3ComposerEditorView, behavior: String) in
        view.setEnterBehavior(behavior)
      }
      Prop("textPasteThresholdBytes") { (view: T3ComposerEditorView, threshold: Int) in
        view.setTextPasteThresholdBytes(threshold)
      }
      Prop("maxInputChars") { (view: T3ComposerEditorView, maxInputChars: Int) in
        view.setMaxInputChars(maxInputChars)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerSubmit",
        "onComposerPasteImages",
        "onComposerContextPress",
        "onComposerPasteText",
        "onComposerContentSizeChange"
      )

      AsyncFunction("focus") { (view: T3ComposerEditorView) in
        view.focusEditor()
      }
      AsyncFunction("blur") { (view: T3ComposerEditorView) in
        view.blurEditor()
      }
      AsyncFunction("setSelection") { (view: T3ComposerEditorView, start: Int, end: Int) in
        view.setSelection(start: start, end: end)
      }
    }
  }
}
