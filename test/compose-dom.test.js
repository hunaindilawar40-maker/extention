/**
 * DOM-level tests for the Zoho compose automation logic in content.js.
 *
 * Regression tests for "Could not find the email body editor in the Zoho
 * compose window", which happens when Zoho mounts the compose body editor:
 *  - inside a same-origin iframe within the compose dialog (its own
 *    <body contenteditable> being the editable surface), or
 *  - inside a designMode="on" iframe (older Zoho editor style — no
 *    contenteditable attribute at all),
 * while To/Subject live in the top document. A scoped lookup that only
 * queries the compose element can never cross the iframe boundary.
 *
 * content.js is an IIFE that touches chrome.* on load, so it runs inside a
 * jsdom window with a chrome stub and its internals are exercised through the
 * __AOZ_EXPOSE_FOR_TESTS__ seam (inert in production).
 *
 * jsdom is a devDependency — these tests skip gracefully when it is not
 * installed, so `npm test` keeps working in dependency-free checkouts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let JSDOM = null;
let hasJsdom = true;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  hasJsdom = false;
}
const maybeSkip = hasJsdom ? false : "jsdom not installed (run: npm install)";

const contentSrc = readFileSync(new URL("../content.js", import.meta.url), "utf8");

function makeZohoDom({ editorMode = "iframe-body", nested = false } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
      <div id="app">
        <button data-id="createMail" title="New Mail">New Mail</button>
        <div role="dialog" class="composeview" id="compose">
          <div class="hdr">
            <div contenteditable="true" aria-label="To" id="toField" role="textbox"></div>
            <input aria-label="Subject" id="subjectField" />
          </div>
          <div class="bodyarea" id="bodyArea"></div>
          <button aria-label="Send" id="sendBtn">Send</button>
        </div>
      </div>
    </body></html>`,
    { url: "https://mail.zoho.com/zm/", pretendToBeVisual: true, runScripts: "dangerously" }
  );

  const { window } = dom;
  const doc = window.document;

  // isVisible() requires a non-collapsed box.
  window.Element.prototype.getBoundingClientRect = function () {
    return { width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300 };
  };

  // Mount the editor the way Zoho does: inside an iframe in the compose dialog.
  const mountInto = (parentDoc, parentEl) => {
    const frame = parentDoc.createElement("iframe");
    parentEl.appendChild(frame);
    const fdoc = frame.contentDocument;
    // Each frame is its own realm with its own Element.prototype — patch there too.
    frame.contentWindow.Element.prototype.getBoundingClientRect = function () {
      return { width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300 };
    };
    fdoc.open();
    fdoc.write(
      `<html><head></head><body${
        editorMode === "iframe-body" ? ' contenteditable="true"' : ""
      }><div>Existing signature</div></body></html>`
    );
    fdoc.close();
    if (editorMode === "designmode") fdoc.designMode = "on";
    return { frame, fdoc };
  };

  const { fdoc } = mountInto(doc, doc.getElementById("bodyArea"));
  let nestedFdoc = null;
  if (nested) {
    // Only the doubly-nested frame is the editor; the outer frame is just a
    // passthrough container, so it must not look editable itself.
    const outerBody = fdoc.querySelector("body");
    outerBody.innerHTML = '<div id="editorSlot"></div>';
    outerBody.removeAttribute("contenteditable");
    ({ fdoc: nestedFdoc } = mountInto(fdoc, fdoc.getElementById("editorSlot")));
    nestedFdoc.body.id = "nestedEditor"; // stable marker for cross-realm assertion
  }

  return { dom, window, doc, fdoc, nestedFdoc };
}

function loadContentScript(window) {
  window.__AOZ_EXPOSE_FOR_TESTS__ = true;
  window.chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage(_msg, cb) {
        if (cb) cb({ ok: false, error: "no background in test" });
      }
    },
    storage: {
      local: {
        get(_keys, cb) {
          cb({});
        },
        set(_obj, cb) {
          if (cb) cb();
        }
      }
    }
  };
  window.eval(contentSrc);
  return window.__aozTestHelpers;
}

test(
  "getComposeScope resolves the compose dialog from the To field",
  { skip: maybeSkip },
  () => {
    const { window, doc } = makeZohoDom();
    const h = loadContentScript(window);
    const scope = h.getComposeScope(doc.getElementById("toField"));
    assert.ok(scope, "scope should be found");
    assert.equal(scope.id, "compose");
  }
);

test(
  "body editor inside a same-origin iframe is found via the compose scope",
  { skip: maybeSkip },
  () => {
    // Regression: a scoped lookup that only queried the compose element could
    // never see the editor iframe nested inside it.
    const { window, doc, fdoc } = makeZohoDom({ editorMode: "iframe-body" });
    const h = loadContentScript(window);
    const scope = h.getComposeScope(doc.getElementById("toField"));
    const editor = h.findBodyEditor(scope);
    assert.ok(editor, "iframe body editor should be found");
    assert.equal(editor.ownerDocument, fdoc);
    assert.equal(editor.tagName, "BODY");
    assert.equal(editor.getAttribute("contenteditable"), "true");
  }
);

test(
  "body editor inside a doubly-nested iframe is found without a scope",
  { skip: maybeSkip },
  () => {
    const { window, nestedFdoc } = makeZohoDom({ editorMode: "iframe-body", nested: true });
    const h = loadContentScript(window);
    const editor = h.findBodyEditor(null);
    assert.ok(editor, "nested iframe body editor should be found");
    // Cross-realm wrappers are never reference-equal; assert via a marker.
    assert.equal(editor.tagName, "BODY");
    assert.equal(editor.id, "nestedEditor");
    assert.equal(nestedFdoc.body.id, "nestedEditor");
  }
);

test(
  "designMode iframe editor (no contenteditable attribute) is found",
  { skip: maybeSkip },
  () => {
    const { window, doc, fdoc } = makeZohoDom({ editorMode: "designmode" });
    const h = loadContentScript(window);
    const scope = h.getComposeScope(doc.getElementById("toField"));
    const editor = h.findBodyEditor(scope);
    assert.ok(editor, "designMode editor should be found");
    assert.equal(editor.ownerDocument, fdoc);
    assert.equal(fdoc.designMode, "on");
  }
);

test(
  "contenteditable To field is never mistaken for the body editor",
  { skip: maybeSkip },
  () => {
    const { window, doc } = makeZohoDom({ editorMode: "iframe-body" });
    doc.getElementById("bodyArea").innerHTML = ""; // only the To field remains editable
    const h = loadContentScript(window);
    const scope = h.getComposeScope(doc.getElementById("toField"));
    assert.equal(h.findBodyEditor(scope), null, "To field must be rejected");
  }
);

test(
  "a labelled contenteditable div in the top document is still found (classic layout)",
  { skip: maybeSkip },
  () => {
    const dom = new JSDOM(
      `<!doctype html><html><body>
        <div role="dialog" id="compose">
          <input aria-label="To" id="toField" />
          <div id="editor" aria-label="Body" contenteditable="true" role="textbox"></div>
        </div>
      </body></html>`,
      { url: "https://mail.zoho.com/zm/", pretendToBeVisual: true, runScripts: "dangerously" }
    );
    const { window } = dom;
    window.Element.prototype.getBoundingClientRect = function () {
      return { width: 500, height: 300, top: 0, left: 0, right: 500, bottom: 300 };
    };
    const h = loadContentScript(window);
    const editor = h.findBodyEditor(window.document.getElementById("compose"));
    assert.ok(editor, "classic div editor should be found");
    assert.equal(editor.id, "editor");
  }
);
