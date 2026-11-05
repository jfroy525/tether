"""Right-click menus: macOS's own Copy, Cut, Paste, Look Up and the rest. pywebview empties the menu WebKit builds;
this keeps it and takes out what doesn't belong in an app: browser items (Reload, Back, Open Link, which would load
the page inside Tether) and rarely used text submenus."""
import objc

DROP_IDS = ("Reload", "GoBack", "GoForward", "Stop", "InspectElement", "OpenLink", "OpenImage", "OpenFrame", "OpenMedia",
            "Download", "CopyLinkWithHighlight", "CopyImageURL", "OpenItem")
DROP_TITLES = {"Font", "Paragraph Direction", "Selection Direction", "Transformations", "Substitutions", "Inspect Element", "Reload"}


def tidy(menu) -> None:
    for item in list(menu.itemArray()):
        ident, title = str(item.identifier() or ""), str(item.title() or "")
        if any(ident == "WKMenuItemIdentifier" + d or ident.startswith("WKMenuItemIdentifier" + d) for d in DROP_IDS) or title in DROP_TITLES:
            menu.removeItem_(item)
    items = list(menu.itemArray())  # no separator at the ends or two in a row
    for i, item in enumerate(items):
        if item.isSeparatorItem() and (i == 0 or i == len(items) - 1 or items[i + 1].isSeparatorItem()):
            menu.removeItem_(item)
    while menu.numberOfItems() and menu.itemAtIndex_(0).isSeparatorItem():
        menu.removeItemAtIndex_(0)
    while menu.numberOfItems() and menu.itemAtIndex_(menu.numberOfItems() - 1).isSeparatorItem():
        menu.removeItemAtIndex_(menu.numberOfItems() - 1)


def install(cls) -> None:
    def willOpenMenu_withEvent_(self, menu, event):
        tidy(menu)
    objc.classAddMethods(cls, [objc.selector(willOpenMenu_withEvent_, selector=b"willOpenMenu:withEvent:", signature=b"v@:@@")])
