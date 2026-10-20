#target indesign
/*
 MultiPageImporter 3.3 - InDesign 2026 size-based parent pages
 Based on MultiPageImporter 2.6.2 by Scott Zanelli (GPL v2 or later).
 Copyright (C) 2008-2009 Scott Zanelli.
 Modifications 2026. Distributed under GPL v2 or later.
 PDF / PDF-compatible AI and INDD placement, page range, reverse,
 crop, scaling, fitting, offsets, rotation, optional layer.
*/
(function () {
    var oldInteraction = app.scriptPreferences.userInteractionLevel;
    var doc = null, created = false, oldZero = null, oldOrigin = null;
    var oldHUnits = null, oldVUnits = null, oldScriptUnits = null;
    var layer = null, source = null, sourceDoc = null;
    var stopped = false, progressWindow = null;
    var bleedMaxX = 0, bleedMaxY = 0, bleedNotes = [];
    function progress(total) {
        var w = new Window("palette", "MultiPageImporter 3.4.6 — Progress");
        w.orientation = "column"; w.alignChildren = "fill";
        w.status = w.add("statictext", undefined, "Preparing...");
        w.status.characters = 48;
        w.bar = w.add("progressbar", undefined, 0, total);
        w.bar.preferredSize = [360, 16];
        var b = w.add("button", undefined, "Cancel import");
        b.onClick = function() { stopped = true; b.enabled = false;
            w.status.text = "Stopping after current page..."; w.update(); };
        w.show(); return w;
    }
    function reportImport(placed, skipped, processed, cancelled, failure) {
        var report = "MultiPageImporter 3.4.6 - Import Report\n\n" +
            "Imported: " + placed + "\nSkipped: " + skipped +
            "\nProcessed: " + processed + "\nStatus: " +
            (failure ? "Error" : cancelled ? "Cancelled" : "Completed") +
            (failure ? "\n" + failure : "") +
            (bleedNotes.length ? "\n\nPrepress diagnostics and bleed notes:\n" +
                bleedNotes.join("\n") +
                "\nDocument bleed uses maximum observed values; verify asymmetric PDFs." : "");
        var w = new Window("dialog", "Import Report");
        w.orientation = "column"; w.alignChildren = "fill";
        var t = w.add("edittext", undefined, report, {multiline:true, readonly:true});
        t.preferredSize = [430, 170];
        var buttons = w.add("group"); buttons.alignment = "right";
        var save = buttons.add("button", undefined, "Save report...");
        save.onClick = function() {
            var f = File.saveDialog("Save report", "Text:*.txt");
            if (f) try { f.encoding = "UTF-8";
                if (!f.open("w")) throw Error("Unable to open file");
                f.write(report); f.close();
            } catch(e) { try {f.close();} catch(_) {} alert("Save failed: " + e); }
        };
        buttons.add("button", undefined, "Close", {name:"ok"});
        w.show();
    }
    var prefFile = File(Folder.userData.fsName + "/MultiPageImporter_2026_prefs.txt");
    function loadPrefs() {
        var result = {};
        try {
            if (prefFile.exists && prefFile.open("r")) {
                while (!prefFile.eof) {
                    var line = prefFile.readln(), sep = line.indexOf("=");
                    if (sep > 0) result[line.substring(0,sep)] = line.substring(sep+1);
                }
                prefFile.close();
            }
        } catch(e) { try {prefFile.close();} catch(_) {} }
        return result;
    }
    function savePrefs(p) {
        try {
            if (prefFile.open("w")) {
                for (var key in p) if (p.hasOwnProperty(key))
                    prefFile.writeln(key + "=" + p[key]);
                prefFile.close();
            }
        } catch(e) { try {prefFile.close();} catch(_) {} }
    }
    function makeMapping(first, last, pageCount) {
        var count = last-first+1, result = [];
        var m = new Window("dialog", "Map Source Pages to Document Pages");
        m.orientation = "column"; m.alignChildren = "left";
        m.add("statictext", undefined, "Choose a destination for each source page. Skip is allowed.");
        var viewport = m.add("panel", undefined, "Mappings");
        viewport.orientation = "column"; viewport.alignChildren = "left";
        var selectors = [], items = ["Skip"];
        for (var n=1; n<=pageCount; n++) items.push(String(n));
        for (var k=0; k<count; k++) {
            var r = viewport.add("group");
            r.add("statictext", undefined, "Source " + (first+k) + " →");
            var d = r.add("dropdownlist", undefined, items);
            d.selection = k < pageCount ? k+1 : 0;
            selectors.push(d);
        }
        var buttons = m.add("group"); buttons.alignment = "right";
        buttons.add("button", undefined, "Cancel", {name:"cancel"});
        buttons.add("button", undefined, "OK", {name:"ok"});
        if (m.show() !== 1) return null;
        var used = {};
        for (var j=0; j<selectors.length; j++) {
            var idx = selectors[j].selection.index;
            if (idx && used[idx]) { alert("Destination page " + idx + " is assigned twice."); return null; }
            if (idx) used[idx] = true;
            result.push(idx);
        }
        return result;
    }
    function fail(msg) { throw new Error(msg); }
    function integer(s, label, low, high) {
        var n = Number(s);
        if (!isFinite(n) || Math.floor(n) !== n || n < low || n > high)
            fail(label + " must be a whole number from " + low + " to " + high + ".");
        return n;
    }
    function number(s, label, low, high) {
        var n = Number(s);
        if (!isFinite(n) || n < low || n > high)
            fail(label + " must be between " + low + " and " + high + ".");
        return n;
    }
    function addField(parent, label, value) {
        var row = parent.add("group");
        row.add("statictext", undefined, label);
        var e = row.add("edittext", undefined, String(value));
        e.characters = 9;
        return e;
    }
    function setPagePreference(kind, page) {
        if (kind === "pdf") app.pdfPlacePreferences.pageNumber = page;
        else app.importedPageAttributes.pageNumber = page;
    }
    function getPDFTrimSize(page, sourcePage) {
        var oldCrop = app.pdfPlacePreferences.pdfCrop, probe = null;
        try {
            app.pdfPlacePreferences.pdfCrop = PDFCrop.cropTrim;
            app.pdfPlacePreferences.pageNumber = sourcePage;
            probe = page.rectangles.add();
            probe.geometricBounds = [0,0,100,100];
            var graphic = probe.place(source)[0];
            if (graphic.pdfAttributes && graphic.pdfAttributes.pageNumber !== sourcePage)
                return null; // PDF page numbering wrapped: normal end of source
            // A PDF placed into a 100 pt probe can inherit a fit scale.
            // Normalize the placed graphic to 100% before measuring its crop box.
            try { graphic.absoluteHorizontalScale = 100; graphic.absoluteVerticalScale = 100; } catch (scaleError) {}
            probe.fit(FitOptions.FRAME_TO_CONTENT);
            var b = probe.geometricBounds;
            var w = Math.abs(Number(b[3])-Number(b[1]));
            var h = Math.abs(Number(b[2])-Number(b[0]));
            if (!(w>0 && h>0 && w<15552 && h<15552))
                throw Error("Invalid PDF TrimBox dimensions.");
            return [w,h];
        } finally {
            try { if (probe && probe.isValid) probe.remove(); } catch(e) {}
            app.pdfPlacePreferences.pdfCrop = oldCrop;
            app.pdfPlacePreferences.pageNumber = sourcePage;
        }
    }
    function getPDFBleedSize(page, sourcePage) {
        var oldCrop = app.pdfPlacePreferences.pdfCrop, probe = null;
        try {
            app.pdfPlacePreferences.pdfCrop = PDFCrop.cropBleed;
            app.pdfPlacePreferences.pageNumber = sourcePage;
            probe = page.rectangles.add();
            probe.geometricBounds = [0,0,100,100];
            var graphic = probe.place(source)[0];
            if (graphic.pdfAttributes && graphic.pdfAttributes.pageNumber !== sourcePage)
                return null;
            // A PDF placed into a 100 pt probe can inherit a fit scale.
            // Normalize the placed graphic to 100% before measuring its crop box.
            try { graphic.absoluteHorizontalScale = 100; graphic.absoluteVerticalScale = 100; } catch (scaleError) {}
            probe.fit(FitOptions.FRAME_TO_CONTENT);
            var b = probe.geometricBounds;
            var w = Math.abs(Number(b[3])-Number(b[1]));
            var h = Math.abs(Number(b[2])-Number(b[0]));
            if (!(w>0 && h>0)) throw Error("Cannot measure BleedBox.");
            return [w,h];
        } finally {
            try { if (probe && probe.isValid) probe.remove(); } catch(e) {}
            app.pdfPlacePreferences.pdfCrop = oldCrop;
            app.pdfPlacePreferences.pageNumber = sourcePage;
        }
    }
    function recordBleed(page, sourcePage, trimSize) {
        var bleedSize = getPDFBleedSize(page, sourcePage);
        if (!bleedSize) return;
        // Bounding-box dimensions alone do not reveal asymmetric offsets.
        // Only symmetric bleed can be inferred from the width/height difference.
        var bx = (bleedSize[0]-trimSize[0])/2;
        var by = (bleedSize[1]-trimSize[1])/2;
        if (bx < -0.05 || by < -0.05) {
            bleedNotes.push("Page " + sourcePage + ": BleedBox smaller than TrimBox; check PDF.");
            return;
        }
        bleedMaxX = Math.max(bleedMaxX, bx);
        bleedMaxY = Math.max(bleedMaxY, by);
        bleedNotes.push("Page " + sourcePage + ": nominal symmetric bleed " +
            bx.toFixed(2) + " pt horizontal, " + by.toFixed(2) + " pt vertical.");
    }
    function setDocumentBleed() {
        var dp = doc.documentPreferences;
        dp.documentBleedUniformSize = false;
        dp.documentBleedTopOffset = bleedMaxY;
        dp.documentBleedBottomOffset = bleedMaxY;
        dp.documentBleedInsideOrLeftOffset = bleedMaxX;
        dp.documentBleedOutsideOrRightOffset = bleedMaxX;
    }
    function resizePageToTrim(page, trimSize, context) {
        var w = Number(trimSize[0]), h = Number(trimSize[1]);
        if (!(w > 0 && h > 0)) throw Error("Invalid TrimBox for " + context);
        // page.reframe is supported in InDesign 21.6; the previous
        // ResizeMethods.REPLACING_CURRENT_DIMENSIONS enum does not exist.
        page.reframe(CoordinateSpaces.INNER_COORDINATES, [[0,0],[w,h]]);
        var b = page.bounds, aw = Number(b[3])-Number(b[1]), ah = Number(b[2])-Number(b[0]);
        if (Math.abs(aw-w)>0.5 || Math.abs(ah-h)>0.5)
            throw Error(context + ": expected " + w.toFixed(2) + " x " + h.toFixed(2) +
                " pt; got " + aw.toFixed(2) + " x " + ah.toFixed(2) + " pt.");
    }
    function matchPageToPlacedPDF(page, frame, trimSize) {
        if (page.pageItems.length > 1)
            throw Error("Destination page contains existing items; cannot safely match its size.");
        page.reframe(CoordinateSpaces.INNER_COORDINATES,
            [[0,0],[trimSize[0],trimSize[1]]]);
        frame.fit(FitOptions.FRAME_TO_CONTENT);
        return trimSize;
    }
    var sizeParents = {};
    function applySizeParent(page, trimSize) {
        // One reusable parent spread for each unique TrimBox size.
        var w = Math.round(trimSize[0]*100)/100;
        var h = Math.round(trimSize[1]*100)/100;
        var key = w.toFixed(2) + "x" + h.toFixed(2);
        var parent = sizeParents[key];
        if (!parent || !parent.isValid) {
            parent = doc.masterSpreads.add();
            parent.baseName = "Trim " + (w/72).toFixed(3) + " x " + (h/72).toFixed(3) + " in";
            // Keep both sides consistent when the document uses facing pages.
            for (var j = 0; j < parent.pages.length; j++) {
                resizePageToTrim(parent.pages[j], [w,h], "Parent page resize");
            }
            sizeParents[key] = parent;
        }
        page.appliedMaster = parent;
    }
    // Read explicit page-box coordinates when the PDF uses uncompressed page
    // dictionaries. For compressed object streams, use the safe centered fallback.
    var pdfBoxCache = null;
    function readPDFBoxes(file) {
        var result = [], f = new File(file.fsName);
        // Avoid loading/scanning large PDFs synchronously before the progress UI.
        // Larger files use the existing centered-crop fallback.
        if (!f.exists || f.length > 2 * 1024 * 1024) return result;
        f.encoding = "BINARY";
        if (!f.open("r")) return result;
        var data = f.read(2 * 1024 * 1024 + 1); f.close();
        if (data.length > 2 * 1024 * 1024) return result;
        var re = /\b\d+\s+\d+\s+obj\b([\s\S]*?)endobj/g, m;
        function box(dict, key) {
            var rx = new RegExp("/" + key + "\\s*\\[\\s*([-+\\d.]+)\\s+([-+\\d.]+)\\s+([-+\\d.]+)\\s+([-+\\d.]+)\\s*\\]");
            var a = rx.exec(dict);
            return a ? [Number(a[1]),Number(a[2]),Number(a[3]),Number(a[4])] : null;
        }
        while ((m = re.exec(data)) !== null) {
            var d = m[1];
            if (!/\/Type\s*\/Page\b/.test(d)) continue;
            var trim = box(d,"TrimBox"), bleed = box(d,"BleedBox"), media = box(d,"MediaBox");
            if (!trim || !media) { result.push(null); continue; }
            result.push({trim:trim, bleed:bleed || media, media:media});
        }
        return result;
    }
    function alignTrimBoxToPage(page, frame, options, sourcePage) {
        var boxes = pdfBoxCache && pdfBoxCache[sourcePage-1];
        var fb = frame.geometricBounds, pb = page.bounds;
        var fw = Number(fb[3])-Number(fb[1]);
        var fh = Number(fb[2])-Number(fb[0]);
        var trimW = Number(pb[3])-Number(pb[1]);
        var trimH = Number(pb[2])-Number(pb[0]);
        var leftBleed = (fw-trimW)/2, topBleed = (fh-trimH)/2;
        if (boxes) {
            // PDF coordinates use a bottom-left origin. For an unrotated PDF,
            // trim left and top are computed from the selected placement box.
            var selected = null;
            if (options.pdfCropIndex === 2) selected = boxes.trim;
            else if (options.pdfCropIndex === 3) selected = boxes.bleed;
            else if (options.pdfCropIndex === 4) selected = boxes.media;
            if (selected) {
                leftBleed = boxes.trim[0] - selected[0];
                topBleed = selected[3] - boxes.trim[3];
                // Use PDF point-to-placed-frame scale to tolerate user scaling.
                var sw = selected[2]-selected[0], sh = selected[3]-selected[1];
                if (sw>0 && sh>0) {
                    leftBleed *= fw/sw;
                    topBleed *= fh/sh;
                }
            }
        } else {
            bleedNotes.push("Page " + sourcePage + ": PDF box coordinates unavailable; centered crop alignment used.");
        }
        // InDesign uses top-left positioning. Negative bleed offsets place
        // the trim boundary exactly on the page boundary.
        frame.move(undefined,[Number(pb[1])-leftBleed-Number(fb[1])+options.offsetX,
            Number(pb[0])-topBleed-Number(fb[0])+options.offsetY]);
    }
    function centerFrameOnPage(page, frame, options) {
        // Re-read page bounds AFTER reframe: subsequent pages may have moved
        // when previous pages were resized.
        var pb = page.bounds, fb = frame.geometricBounds;
        var pw = Number(pb[3]) - Number(pb[1]);
        var ph = Number(pb[2]) - Number(pb[0]);
        var fw = Number(fb[3]) - Number(fb[1]);
        var fh = Number(fb[2]) - Number(fb[0]);
        var x = Number(pb[1]) + (pw-fw) * options.horizontal/2 + options.offsetX;
        var y = Number(pb[0]) + (ph-fh) * options.vertical/2 + options.offsetY;
        frame.move(undefined, [x-Number(fb[1]), y-Number(fb[0])]);
    }
    function placeOne(page, sourcePage, options, kind) {
        setPagePreference(kind, sourcePage);
        var bounds = page.bounds;
        var top = Number(bounds[0]), left = Number(bounds[1]);
        var h = Number(bounds[2]) - top, w = Number(bounds[3]) - left;
        var trimSize = null;
        if (options.matchSize && kind === "pdf") {
            if (page.pageItems.length)
                throw Error("Destination page must be empty for automatic TrimBox sizing.");
            trimSize = getPDFTrimSize(page, sourcePage);
            if (trimSize === null) return false;
            if (options.autoBleed) recordBleed(page, sourcePage, trimSize);
            if (sourcePage <= 3 || sourcePage === 12)
                bleedNotes.push("Size diagnostic source page " + sourcePage +
                    ": measured PDF TrimBox " + trimSize[0].toFixed(2) +
                    " x " + trimSize[1].toFixed(2) + " pt.");
        }
        // Resize an EMPTY page first. Resizing a page while a placed frame
        // still uses its old bounds can trigger InDesign's pasteboard limit.
        if (trimSize && options.matchSize && kind === "pdf") {
            try {
                resizePageToTrim(page, trimSize, "Destination page resize");
            } catch (resizeError) {
                throw Error("Resizing destination page: " + resizeError);
            }
            if (options.createParents) {
                try { applySizeParent(page, trimSize); }
                catch (parentError) { throw Error("Applying size parent: " + parentError); }
            }
            // Parent application can change the effective page geometry in
            // InDesign 21.6. Enforce the PDF TrimBox dimensions LAST.
            try {
                resizePageToTrim(page, trimSize, "Destination page resize");
            } catch (finalResizeError) {
                throw Error("Enforcing TrimBox size after parent assignment: " + finalResizeError);
            }
            bounds = page.bounds;
            top = Number(bounds[0]); left = Number(bounds[1]);
            h = Number(bounds[2]) - top; w = Number(bounds[3]) - left;
            if (sourcePage <= 3 || sourcePage === 12)
                bleedNotes.push("Size diagnostic destination page " + (page.documentOffset+1) +
                    ": " + w.toFixed(2) + " x " + h.toFixed(2) + " pt.");
            if (Math.abs(w-trimSize[0]) > 0.5 || Math.abs(h-trimSize[1]) > 0.5)
                throw Error("TrimBox size mismatch after resize: expected " +
                    trimSize[0].toFixed(2) + " x " + trimSize[1].toFixed(2) +
                    " pt; actual " + w.toFixed(2) + " x " + h.toFixed(2) + " pt.");
        }
        var frame = page.rectangles.add();
        if (layer) frame.itemLayer = layer;
        frame.label = "Multi_Page_Importer_Rect";
        frame.strokeWeight = 0;
        frame.fillColor = doc.swatches.itemByName("None");
        frame.geometricBounds = [top, left, top + h, left + w];
        try {
            var placedGraphic = frame.place(source)[0];
            if (kind === "pdf" && placedGraphic.pdfAttributes &&
                placedGraphic.pdfAttributes.pageNumber !== sourcePage) {
                frame.remove();
                return false;
            }
            if (options.matchSize && kind === "pdf") {
                // The probe explicitly resets PDF graphics to 100%, but the
                // actual placement previously did not. InDesign can place into
                // a page-sized frame at an inherited fitting scale (e.g. 90%).
                // Normalize the PDF graphic BEFORE fitting its frame to content.
                try {
                    placedGraphic.absoluteHorizontalScale = 100;
                    placedGraphic.absoluteVerticalScale = 100;
                } catch (scaleError) {
                    throw Error("Resetting placed PDF to 100%: " + scaleError);
                }
                try { frame.fit(FitOptions.FRAME_TO_CONTENT); }
                catch (fitError) { throw Error("Fitting placed PDF: " + fitError); }
                if (sourcePage <= 3 || sourcePage === 12) {
                    var actualBounds = frame.geometricBounds;
                    bleedNotes.push("Placement diagnostic source page " + sourcePage +
                        ": crop frame " + (Number(actualBounds[3])-Number(actualBounds[1])).toFixed(2) +
                        " x " + (Number(actualBounds[2])-Number(actualBounds[0])).toFixed(2) +
                        " pt at 100% PDF scale.");
                }
                try { frame.rotationAngle = options.rotation; }
                catch (rotationError) { throw Error("Rotating placed PDF: " + rotationError); }
                try { alignTrimBoxToPage(page, frame, options, sourcePage); }
                catch (alignmentError) { throw Error("Aligning TrimBox: " + alignmentError); }
                return true;
            }
            frame.rotationAngle = options.rotation;
            if (options.fit) {
                var bTop = top, bLeft = left, bBottom = top + h, bRight = left + w;
                if (options.bleed) {
                    var dp = doc.documentPreferences;
                    bTop -= dp.documentBleedTopOffset;
                    bLeft -= dp.documentBleedInsideOrLeftOffset;
                    bBottom += dp.documentBleedBottomOffset;
                    bRight += dp.documentBleedOutsideOrRightOffset;
                }
                frame.geometricBounds = [bTop, bLeft, bBottom, bRight];
                frame.fit(options.proportional ? FitOptions.PROPORTIONALLY : FitOptions.CONTENT_TO_FRAME);
                if (options.proportional) frame.fit(FitOptions.FRAME_TO_CONTENT);
            } else {
                var g = frame.allGraphics[0];
                g.horizontalScale = options.scaleX;
                g.verticalScale = options.scaleY;
                frame.fit(FitOptions.FRAME_TO_CONTENT);
            }
            var gb = frame.geometricBounds;
            var fh = gb[2] - gb[0], fw = gb[3] - gb[1];
            var x = left, y = top;
            if (options.horizontal === 1) x += (w - fw) / 2;
            if (options.horizontal === 2) x += w - fw;
            if (options.vertical === 1) y += (h - fh) / 2;
            if (options.vertical === 2) y += h - fh;
            frame.move(undefined, [x + options.offsetX - gb[1], y + options.offsetY - gb[0]]);
            return true;
        } catch (e) {
            try { frame.remove(); } catch (_) {}
            throw e;
        }
    }
    try {
        app.scriptPreferences.userInteractionLevel = UserInteractionLevels.INTERACT_WITH_ALL;
        source = File.openDialog("Select PDF, PDF-compatible AI, or InDesign file");
        if (!source) return;
        var name = source.name.toLowerCase();
        var kind = /\.(pdf|ai)$/.test(name) ? "pdf" : (/\.indd$/.test(name) ? "indd" : null);
        if (!kind) fail("Choose a .pdf, .ai, or .indd file.");
        var count = 0, width = 612, height = 792;
        if (kind === "indd") {
            sourceDoc = app.open(source, false);
            count = sourceDoc.pages.length;
            width = sourceDoc.documentPreferences.pageWidth;
            height = sourceDoc.documentPreferences.pageHeight;
            sourceDoc.close(SaveOptions.NO);
            sourceDoc = null;
        }
        var prefs = loadPrefs();
        var dlg = new Window("dialog", "MultiPageImporter 3.4.1 — InDesign 2026");
        dlg.orientation = "column";
        dlg.alignChildren = "fill";
        var info = dlg.add("statictext", undefined,
            kind === "pdf" ? "PDF/AI: enter last page, or use Auto (stops at first repeated page)." :
            "InDesign source: " + count + " pages");
        // Compact two-column layout: prevents the dialog from becoming taller
        // than the available screen on high-DPI and smaller displays.
        var columns = dlg.add("group");
        columns.orientation = "row";
        columns.alignChildren = ["fill", "top"];
        columns.spacing = 10;
        var leftColumn = columns.add("group");
        leftColumn.orientation = "column";
        leftColumn.alignChildren = "fill";
        var rightColumn = columns.add("group");
        rightColumn.orientation = "column";
        rightColumn.alignChildren = "fill";
        var pages = leftColumn.add("panel", undefined, "Page selection");
        pages.orientation = "column"; pages.alignChildren = "left";
        var start = addField(pages, "First source page", 1);
        var end = addField(pages, "Last source page", kind === "indd" ? count : 1);
        var auto = pages.add("checkbox", undefined, "Auto-detect final PDF/AI page");
        auto.value = kind === "pdf";
        auto.enabled = kind === "pdf";
        var docStart = addField(pages, "Destination start page", 1);
        var reverse = pages.add("checkbox", undefined, "Reverse source order");
        var map = pages.add("checkbox", undefined, "Map source pages to existing document pages");
        map.helpTip = "Available with a specified source range and an open destination document.";
        var sizing = leftColumn.add("panel", undefined, "Sizing");
        sizing.orientation = "column"; sizing.alignChildren = "left";
        var fit = sizing.add("checkbox", undefined, "Fit to destination page");
        var prop = sizing.add("checkbox", undefined, "Keep proportions");
        prop.value = true;
        var bleed = sizing.add("checkbox", undefined, "Include document bleed when fitting");
        var matchSize = sizing.add("checkbox", undefined,
            "Match destination page size to PDF TrimBox (experimental)");
        matchSize.helpTip = "Resizes each destination page to the PDF TrimBox, independent of placement crop. Use only on empty pages.";
        var autoBleed = sizing.add("checkbox", undefined,
            "Set document bleed from PDF BleedBox (assumes symmetric bleed)");
        autoBleed.value = false;
        autoBleed.helpTip = "Uses maximum nominal bleed across pages. Cannot infer asymmetric bleed from box sizes.";
        var createParents = sizing.add("checkbox", undefined,
            "Create and apply parent pages for each unique TrimBox size");
        createParents.value = true;
        createParents.helpTip = "One parent per distinct PDF TrimBox size; reused for matching pages.";
        var sx = addField(sizing, "Horizontal scale %", 100);
        var sy = addField(sizing, "Vertical scale %", 100);
        var pos = rightColumn.add("panel", undefined, "Position");
        pos.orientation = "column"; pos.alignChildren = "left";
        var anchor = pos.add("dropdownlist", undefined,
            ["Top left","Top center","Top right","Center left","Center","Center right",
             "Bottom left","Bottom center","Bottom right"]);
        anchor.selection = 4;
        var ox = addField(pos, "X offset (points)", 0);
        var oy = addField(pos, "Y offset (points)", 0);
        var rotation = pos.add("dropdownlist", undefined, ["0","90","180","270"]);
        rotation.selection = 0;
        var place = rightColumn.add("panel", undefined, "Placement");
        place.orientation = "column"; place.alignChildren = "left";
        var cropItems = kind === "pdf" ?
            ["Crop","Art","Trim","Bleed","Media"] :
            ["Page bounding box","Bleed bounding box","Slug bounding box"];
        var crop = place.add("dropdownlist", undefined, cropItems);
        crop.selection = kind === "pdf" ? 0 : 0;
        var transparent = place.add("checkbox", undefined, "Transparent PDF background");
        transparent.value = true; transparent.enabled = kind === "pdf";
        var newLayer = place.add("checkbox", undefined, "Place on a new layer");
        // Restore commonly used settings without changing the proven placement routine.
        function savedBool(key, fallback) { return prefs[key] === undefined ? fallback : prefs[key] === "true"; }
        function savedNum(key, fallback) { return prefs[key] === undefined ? fallback : Number(prefs[key]); }
        fit.value = savedBool("fit",false);
        matchSize.value = false; // Always opt in: resizing is a document mutation.
        prop.value = savedBool("prop",true);
        bleed.value = savedBool("bleed",false);
        sx.text = savedNum("sx",100); sy.text = savedNum("sy",100);
        ox.text = savedNum("ox",0); oy.text = savedNum("oy",0);
        anchor.selection = Math.max(0,Math.min(8,savedNum("anchor",4)));
        rotation.selection = Math.max(0,Math.min(3,savedNum("rotation",0)));
        crop.selection = Math.max(0,Math.min(cropItems.length-1,savedNum(kind+"Crop",0)));
        transparent.value = savedBool("transparent",true);
        newLayer.value = savedBool("newLayer",false);
        var buttons = dlg.add("group");
        buttons.alignment = "right";
        buttons.add("button", undefined, "Cancel", {name:"cancel"});
        buttons.add("button", undefined, "Import", {name:"ok"});
        // Center only after ScriptUI has computed its final bounds.
        dlg.onShow = function () { this.center(); };
        dlg.center();
        if (dlg.show() !== 1) return;
        var first = integer(start.text, "First source page", 1, 999999);
        var last = integer(end.text, "Last source page", 1, 999999);
        var target = integer(docStart.text, "Destination start page", 1, 999999);
        var automatic = auto.value && kind === "pdf";
        if (!automatic && last < first) fail("Last source page cannot precede first.");
        if (kind === "indd" && last > count) fail("Source has only " + count + " pages.");
        if (automatic && reverse.value) fail("Reverse order requires a known last source page.");
        if (map.value && (automatic || reverse.value || app.documents.length === 0))
            fail("Mapping requires an open document, a specified page range, and reverse order off.");
        var mapping = null;
        if (map.value) {
            if (last-first+1 > 80) fail("Mapping dialog supports up to 80 source pages per batch.");
            if (last-first+1 > app.activeDocument.pages.length)
                fail("Not enough destination pages for unique mapping.");
            mapping = makeMapping(first,last,app.activeDocument.pages.length);
            if (mapping === null) return;
        }
        savePrefs({fit:fit.value,prop:prop.value,bleed:bleed.value,
            sx:sx.text,sy:sy.text,ox:ox.text,oy:oy.text,
            anchor:anchor.selection.index,rotation:rotation.selection.index,
            transparent:transparent.value,newLayer:newLayer.value,
            pdfCrop:kind==="pdf"?crop.selection.index:savedNum("pdfCrop",0),
            inddCrop:kind==="indd"?crop.selection.index:savedNum("inddCrop",0)});
        if (createParents.value && !matchSize.value) createParents.value = false;
        if (autoBleed.value && (!matchSize.value || kind !== "pdf"))
            fail("Automatic bleed requires PDF TrimBox page-size matching.");
        if (matchSize.value && kind !== "pdf") fail("Page-size matching is available for PDF/AI only.");
        if (matchSize.value && (fit.value || Number(rotation.selection.text) !== 0))
            fail("Turn off Fit to Page and set Rotation to 0 when matching PDF page sizes.");
        if (kind === "pdf") pdfBoxCache = readPDFBoxes(source);
        var options = {
            pdfCropIndex: kind === "pdf" ? crop.selection.index : -1,
            autoBleed: autoBleed.value,
            createParents: createParents.value,
            matchSize: matchSize.value,
            fit: fit.value, proportional: prop.value, bleed: bleed.value,
            scaleX: number(sx.text,"Horizontal scale",1,400),
            scaleY: number(sy.text,"Vertical scale",1,400),
            offsetX: number(ox.text,"X offset",-100000,100000),
            offsetY: number(oy.text,"Y offset",-100000,100000),
            rotation: Number(rotation.selection.text),
            horizontal: anchor.selection.index % 3,
            vertical: Math.floor(anchor.selection.index / 3)
        };
        if (app.documents.length === 0) {
            doc = app.documents.add();
            created = true;
            doc.documentPreferences.facingPages = false;
            // Source dimensions are available reliably for INDD only.
            if (kind === "indd") {
                doc.documentPreferences.pageWidth = width;
                doc.documentPreferences.pageHeight = height;
            }
        } else doc = app.activeDocument;
        oldZero = doc.zeroPoint;
        oldOrigin = doc.viewPreferences.rulerOrigin;
        doc.zeroPoint = [0,0];
        doc.viewPreferences.rulerOrigin = RulerOrigin.PAGE_ORIGIN;
        // Force numeric geometric bounds and reframe coordinates to be points.
        oldHUnits = doc.viewPreferences.horizontalMeasurementUnits;
        oldVUnits = doc.viewPreferences.verticalMeasurementUnits;
        oldScriptUnits = app.scriptPreferences.measurementUnit;
        doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
        doc.viewPreferences.verticalMeasurementUnits = MeasurementUnits.POINTS;
        app.scriptPreferences.measurementUnit = MeasurementUnits.POINTS;
        if (newLayer.value) layer = doc.layers.add({name:"MultiPageImporter_" + (new Date()).getTime()});
        if (kind === "pdf") {
            var pdfCrops = [PDFCrop.cropPDF, PDFCrop.cropArt, PDFCrop.cropTrim,
                        PDFCrop.cropBleed, PDFCrop.cropMedia];
            app.pdfPlacePreferences.pdfCrop = pdfCrops[crop.selection.index];
            app.pdfPlacePreferences.transparentBackground = transparent.value;
        } else {
            var indCrops = [ImportedPageCropOptions.CROP_CONTENT,
                            ImportedPageCropOptions.CROP_BLEED,
                            ImportedPageCropOptions.CROP_SLUG];
            app.importedPageAttributes.importedPageCrop = indCrops[crop.selection.index];
        }
        var placed = 0, skipped = 0, processed = 0, maxAuto = 10000;
        var total = automatic ? maxAuto : last - first + 1;
        var failure = null;
        try {
            progressWindow = progress(total);
            for (var k = 0; k < total; k++) {
                if (stopped) break;
                var sourcePage = reverse.value ? last - k : first + k;
                if (mapping && mapping[k] === 0) {
                    skipped++; processed++;
                } else {
                    var destination = mapping ? mapping[k]-1 : target-1+k;
                    while (doc.pages.length <= destination) doc.pages.add(LocationOptions.AT_END);
                    var destinationPage = doc.pages[destination];
                    try {
                        if (!placeOne(destinationPage, sourcePage, options, kind)) {
                            if (destinationPage.pageItems.length === 0 && destination === doc.pages.length - 1 &&
                                doc.pages.length > 1 && destination >= target) destinationPage.remove();
                            break;
                        }
                        placed++; processed++;
                    } catch (placementError) {
                        failure = "Failed placing source page " + sourcePage +
                            " onto document page " + (destination+1) + ": " + placementError;
                        break;
                    }
                }
                progressWindow.bar.value = processed;
                progressWindow.status.text = automatic ?
                    "Checked " + processed + " source pages" :
                    "Processed " + processed + " of " + total + " source pages";
                progressWindow.update();
            }
        } finally {
            if (progressWindow) { try {progressWindow.close();} catch (_) {} progressWindow = null; }
        }
        if (options.autoBleed && placed > 0) {
            try { setDocumentBleed(); }
            catch (bleedError) { failure = (failure ? failure + "\n" : "") +
                "Could not set document bleed: " + bleedError; }
        }
        reportImport(placed, skipped, processed, stopped, failure);
    } catch (e) {
        alert("MultiPageImporter error:\n" + e);
    } finally {
        try { if (progressWindow) progressWindow.close(); } catch (_) {}
        try { if (sourceDoc && sourceDoc.isValid) sourceDoc.close(SaveOptions.NO); } catch (_) {}
        try { if (doc && doc.isValid && oldZero !== null) doc.zeroPoint = oldZero; } catch (_) {}
        try { if (doc && doc.isValid && oldOrigin !== null) doc.viewPreferences.rulerOrigin = oldOrigin; } catch (_) {}
        try { if (oldHUnits !== null && doc && doc.isValid) doc.viewPreferences.horizontalMeasurementUnits = oldHUnits; } catch (_) {}
        try { if (oldVUnits !== null && doc && doc.isValid) doc.viewPreferences.verticalMeasurementUnits = oldVUnits; } catch (_) {}
        try { if (oldScriptUnits !== null) app.scriptPreferences.measurementUnit = oldScriptUnits; } catch (_) {}
        try { app.scriptPreferences.userInteractionLevel = oldInteraction; } catch (_) {}
    }
})();
