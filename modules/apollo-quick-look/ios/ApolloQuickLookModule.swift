import ExpoModulesCore
import QuickLook

public final class ApolloQuickLookModule: Module {
  private var presentation: Presentation?

  public func definition() -> ModuleDefinition {
    Name("ApolloQuickLook")

    AsyncFunction("preview") { (uris: [String], titles: [String], index: Int, promise: Promise) in
      let urls = uris.compactMap(URL.init(string:)).filter(\.isFileURL)
      guard urls.count == uris.count, !urls.isEmpty else {
        return promise.reject("ERR_QUICK_LOOK_FILE", "Only local files can be previewed.")
      }
      guard self.presentation == nil, let presenter = self.appContext?.utilities?.currentViewController() else {
        return promise.reject("ERR_QUICK_LOOK_PRESENTER", "Could not open the preview.")
      }
      let items = urls.enumerated().map { offset, url in Item(url: url, title: offset < titles.count ? titles[offset] : nil) }
      let presentation = Presentation(items: items) { [weak self] in
        self?.presentation = nil
        promise.resolve()
      }
      self.presentation = presentation
      let controller = QLPreviewController()
      controller.dataSource = presentation
      controller.delegate = presentation
      controller.currentPreviewItemIndex = min(max(index, 0), items.count - 1)
      presenter.present(controller, animated: true)
    }.runOnQueue(.main)
  }
}

private final class Item: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?

  init(url: URL, title: String?) {
    previewItemURL = url
    previewItemTitle = title
  }
}

private final class Presentation: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  private let items: [Item]
  private let onDismiss: () -> Void

  init(items: [Item], onDismiss: @escaping () -> Void) {
    self.items = items
    self.onDismiss = onDismiss
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { items.count }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { items[index] }

  func previewControllerDidDismiss(_ controller: QLPreviewController) { onDismiss() }
}
