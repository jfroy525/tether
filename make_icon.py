"""Draws assets/icon.png and icon.icns from assets/logo-art.png: the folded blue ribbon T, on black."""
import subprocess
from pathlib import Path
import AppKit
from Foundation import NSMakeRect, NSMakePoint

HERE = Path(__file__).resolve().parent


ART = HERE / "assets" / "logo-art.png"
# a square around the mark in logo-art.png (1254 px, top-left origin), so the mark fills about 58% of the icon
CROP_X, CROP_Y, CROP_SIDE = 44, 43, 1180


def draw(size: int) -> AppKit.NSBitmapImageRep:
    """Tether: the logo art cropped around its mark, inside the standard macOS icon shape (824 of 1024, radius 185)."""
    rep = AppKit.NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
        None, size, size, 8, 4, True, False, AppKit.NSDeviceRGBColorSpace, 0, 0)
    art = AppKit.NSBitmapImageRep.imageRepWithContentsOfFile_(str(ART))
    w, h = art.pixelsWide(), art.pixelsHigh()
    art.setSize_((w, h))
    AppKit.NSGraphicsContext.saveGraphicsState()
    ctx = AppKit.NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep)
    ctx.setImageInterpolation_(AppKit.NSImageInterpolationHigh)
    AppKit.NSGraphicsContext.setCurrentContext_(ctx)
    s = size / 1024
    tile = NSMakeRect(100 * s, 100 * s, 824 * s, 824 * s)
    AppKit.NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(tile, 185 * s, 185 * s).addClip()
    art.drawInRect_fromRect_operation_fraction_respectFlipped_hints_(
        tile, NSMakeRect(CROP_X, h - CROP_Y - CROP_SIDE, CROP_SIDE, CROP_SIDE), AppKit.NSCompositingOperationCopy, 1.0, True, None)
    AppKit.NSGraphicsContext.restoreGraphicsState()
    return rep


def save(rep, path: Path) -> None:
    rep.representationUsingType_properties_(AppKit.NSBitmapImageFileTypePNG, {}).writeToFile_atomically_(str(path), True)


if __name__ == "__main__":
    save(draw(1024), HERE / "assets" / "icon.png")
    iconset = HERE / "assets" / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    for n in (16, 32, 128, 256, 512):
        save(draw(n), iconset / f"icon_{n}x{n}.png")
        save(draw(n * 2), iconset / f"icon_{n}x{n}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(HERE / "assets" / "icon.icns")], check=True)
    print("icon done")
