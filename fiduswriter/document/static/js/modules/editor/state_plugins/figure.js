import {Plugin, PluginKey} from "prosemirror-state"
import {DOMSerializer} from "prosemirror-model"
import {FigureDialog} from "../dialogs"
import {addAlert} from "../../common"
import {
    FIG_CATS
} from "../../schema/i18n"

const key = new PluginKey('figureMenu')

class FigureView {
    constructor(node, view, getPos, options) {

        this.node = node
        this.view = view
        this.getPos = getPos
        this.options = options

        this.serializer = DOMSerializer.fromSchema(node.type.schema)

        this.dom = this.serializer.serializeNode(this.node)
        this.menuButton = document.createElement("button")
        this.menuButton.classList.add('figure-menu-btn')
        this.menuButton.innerHTML = '<span class="dot-menu-icon"><i class="fa fa-ellipsis-v"></i></span>'
        this.dom.insertBefore(this.menuButton, this.dom.firstChild)
        this.menuButton.addEventListener('click', () => {

           const editor = this.options.editor
           if (editor.ws.isOnline()){
            const dialog = new FigureDialog(editor)
            dialog.init()
           }else{
            addAlert('error', gettext("You're currently Offline. Please try editing the image after you're Online."))
           }
        })
    }
}


export const figurePlugin = function(options) {
    return new Plugin({
        key,
        state: {
            init(_config, _state) {
                if (options.editor.docInfo.access_rights === 'write') {
                    this.spec.props.nodeViews['figure'] =
                        (node, view, getPos) => new FigureView(node, view, getPos, options)
                }
                return {}
            },
            apply(tr, prev) {
                return prev
            }
        },
        props: {
            nodeViews: {}
        },
        view(_view) {
            let userLanguage = options.editor.view.state.doc.firstChild.attrs.language
            document.querySelectorAll('*[class^="figure-cat-"]').forEach(el => el.innerHTML = FIG_CATS[el.dataset.figureCategory][userLanguage])
            return {
                update: (_view, _prevState) => {
                    let selector = '*[class^="figure-cat-"]:empty'
                    if (options.editor.view.state.doc.firstChild.attrs.language !== userLanguage) {
                        selector = '*[class^="figure-cat-"]'
                        userLanguage = options.editor.view.state.doc.firstChild.attrs.language
                    }
                    document.querySelectorAll(selector).forEach(el => el.innerHTML = FIG_CATS[el.dataset.figureCategory][userLanguage])
                }
            }
        }
    })
}
