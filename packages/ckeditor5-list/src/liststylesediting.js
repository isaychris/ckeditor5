/**
 * @license Copyright (c) 2003-2020, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module list/liststylesediting
 */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';
import ListEditing from './listediting';
import ListStylesCommand from './liststylescommand';

const DEFAULT_LIST_TYPE = 'default';

/**
 * The list styles engine feature.
 *
 * It sets value for the `listItem` attribute for the {@link module:list/list~List `<listItem>`} element that
 * allows modifying list style type.
 *
 * @extends module:core/plugin~Plugin
 */
export default class ListStylesEditing extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ ListEditing ];
	}

	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'ListStylesEditing';
	}

	init() {
		const editor = this.editor;
		const model = editor.model;

		// Extend schema.
		model.schema.extend( 'listItem', {
			allowAttributes: [ 'listStyle' ]
		} );

		editor.commands.add( 'listStyles', new ListStylesCommand( editor ) );

		// Fix list attributes when modifying their nesting levels (the `listIndent` attribute).
		this.listenTo( editor.commands.get( 'indentList' ), 'execute', fixListAfterIndentListCommand( editor ) );
		this.listenTo( editor.commands.get( 'outdentList' ), 'execute', fixListAfterOutdentListCommand( editor ) );

		// Register a post-fix that ensures that the `listStyle` attribute is specified in each `listItem` element.
		model.document.registerPostFixer( fixListStyleAttributeOnListItemElements( editor ) );

		// Disallow the `listStyle` attribute on to-do lists.
		model.schema.addAttributeCheck( ( context, attributeName ) => {
			const item = context.last;

			if ( attributeName == 'listStyle' && item.name == 'listItem' && item.getAttribute( 'listType' ) == 'todo' ) {
				return false;
			}
		} );

		// Set up conversion.
		editor.conversion.for( 'upcast' ).add( upcastListItem() );
		editor.conversion.for( 'downcast' ).add( downcastListStyleAttribute() );
	}
}

// Returns a converter that consumes the `style` attribute and search for `list-style-type` definition.
// If not found, the `"default"` value will be used.
//
// @private
// @returns {Function}
function upcastListItem() {
	return dispatcher => {
		dispatcher.on( 'element:li', ( evt, data, conversionApi ) => {
			const listParent = data.viewItem.parent;
			const listStyle = listParent.getStyle( 'list-style-type' ) || DEFAULT_LIST_TYPE;
			const listItem = data.modelRange.start.nodeAfter;

			conversionApi.writer.setAttribute( 'listStyle', listStyle, listItem );
		}, { priority: 'low' } );
	};
}

// Returns a converter that adds the `list-style-type` definition as a value for the `style` attribute.
// The `"default"` value is removed and not present in the view/data.
//
// @private
// @returns {Function}
function downcastListStyleAttribute() {
	return dispatcher => {
		dispatcher.on( 'attribute:listStyle:listItem', ( evt, data, conversionApi ) => {
			const viewWriter = conversionApi.writer;
			const currentItem = data.item;
			const previousItem = currentItem.previousSibling;
			const viewItem = conversionApi.mapper.toViewElement( currentItem );
			const listStyle = data.attributeNewValue;

			// Parsing the first element in a list. Just set the attribute.
			if ( !previousItem || !previousItem.is( 'element', 'listItem' ) ) {
				return setListStyle( viewWriter, listStyle, viewItem.parent );
			}

			// But if previous element is the list item, we must be sure that those two items belong to the same list.
			// So, we should check whether the values of the `listType`, `listIndent` and `listStyle` attributes are equal.
			//
			// If the current parsed list item does not belong to the same list that the previous element,
			// the `listStyle` attribute must be set once again since another list is being processed.
			//
			// Note: We ignore the check of the `listStyle` attribute since that case must be handled another way.
			// If two items have the same values for `listType` and `listIndent` but not for `listStyle`,
			// we must split the list container (`<ol>` or `<ul>`) since we're processing two different lists.
			if ( !areRepresentingSameList( previousItem, currentItem ) ) {
				return setListStyle( viewWriter, listStyle, viewItem.parent );
			}

			const previousListStyle = previousItem.getAttribute( 'listStyle' );

			// Since we were ignoring the `listStyle` check, it must be checked before splitting the list container.
			// No change is needed if previous element has the same value of the `listStyle` attribute.
			if ( previousListStyle === listStyle ) {
				return;
			}

			// But if those attributes are different, we must split the parent element
			// and set the attribute for the new created container.
			viewWriter.breakContainer( viewWriter.createPositionBefore( viewItem ) );
			viewWriter.breakContainer( viewWriter.createPositionAfter( viewItem ) );

			setListStyle( viewWriter, listStyle, viewItem.parent );
		}, { priority: 'low' } );
	};

	// Checks whether specified list items belong to the same list.
	//
	// Comparing the `listStyle` attribute is by design since it requires additional actions.
	//
	// @param {module:engine/model/element~Element} listItem1 The first list item to check.
	// @param {module:engine/model/element~Element} listItem2 The second list item to check.
	// @returns {Boolean}
	function areRepresentingSameList( listItem1, listItem2 ) {
		if ( listItem1.getAttribute( 'listType' ) !== listItem2.getAttribute( 'listType' ) ) {
			return false;
		}

		if ( listItem1.getAttribute( 'listIndent' ) !== listItem2.getAttribute( 'listIndent' ) ) {
			return false;
		}

		return true;
	}

	// Updates or removes the `list-style-type` from the `element`.
	//
	// @param {module:engine/view/downcastwriter~DowncastWriter} writer
	// @param {String} listStyle
	// @param {module:engine/view/element~Element} element
	function setListStyle( writer, listStyle, element ) {
		if ( listStyle && listStyle !== DEFAULT_LIST_TYPE ) {
			writer.setStyle( 'list-style-type', listStyle, element );
		} else {
			writer.removeStyle( 'list-style-type', element );
		}
	}
}

// When indenting list, nested list should clear its value for the `listStyle` attribute.
//
// ■ List item 1.
// ■ List item 2.[]
// ■ List item 3.
// editor.execute( 'indentList' );
//
// ■ List item 1.
//     ○ List item 2.[]
// ■ List item 3.
//
// @private
// @param {module:core/editor/editor~Editor} editor
// @returns {Function}
function fixListAfterIndentListCommand( editor ) {
	return () => { // evt
		return editor;
		// This function must be re-written since it does not work correctly.
		// const changedItems = evt.return;
		// const previousSibling = changedItems[ 0 ].previousSibling;
		//
		// const indent = changedItems[ 0 ].getAttribute( 'listIndent' );
		// let listItem = changedItems[ 0 ];
		//
		// console.log( 'looking for indent = ', indent );
		// console.log( 'before do while' );
		//
		// // ■ List item 1.
		// //     ⬤ List item 2.
		// // ■ List item 3.[]
		// // ■ List item 4.
		// //
		// // After indenting the list, `List item 3` should inherit the `listStyle` attribute from `List item 2`.
		// //
		// // ■ List item 1.
		// //     ⬤ List item 2.
		// //     ⬤ List item 3.[]
		// // ■ List item 4.
		//
		// while ( listItem.getAttribute( 'listIndent' ) === indent ) {
		// 	listItem = listItem.previousSibling;
		//
		// 	console.log( listItem.getChild( 0 )._data, 'indent = ', listItem.getAttribute( 'listIndent' ) );
		// }
		//
		// console.log( 'after do while' );
		// console.log( listItem, listItem.getChild( 0 )._data );
		//
		// const itemsToUpdate = changedItems.filter( item => {
		// 	return item.getAttribute( 'listIndent' ) === previousSibling.getAttribute( 'listIndent' ) + 1;
		// } );
		//
		// editor.model.change( writer => {
		// 	for ( const item of itemsToUpdate ) {
		// 		writer.setAttribute( 'listStyle', DEFAULT_LIST_TYPE, item );
		// 	}
		// } );
	};
}

// When outdenting a list, a nested list should copy its value for the `listStyle` attribute
// from the previous sibling list item including the same value for the `listIndent` value.
//
// ■ List item 1.
//     ○ List item 2.[]
// ■ List item 3.
//
// editor.execute( 'outdentList' );
//
// ■ List item 1.
// ■ List item 2.[]
// ■ List item 3.
//
// @private
// @param {module:core/editor/editor~Editor} editor
// @returns {Function}
function fixListAfterOutdentListCommand( editor ) {
	return evt => {
		const changedItems = evt.return.reverse()
			.filter( item => item.is( 'element', 'listItem' ) );

		if ( !changedItems.length ) {
			return;
		}

		const indent = changedItems[ 0 ].getAttribute( 'listIndent' );
		let listItem = changedItems[ 0 ].previousSibling;

		// ■ List item 1.
		//     ○ List item 2.
		//     ○ List item 3.[]
		// ■ List item 4.
		//
		// After outdenting a list, `List item 3` should inherit the `listStyle` attribute from `List item 1`.
		//
		// ■ List item 1.
		//     ○ List item 2.
		// ■ List item 3.[]
		// ■ List item 4.
		if ( listItem.is( 'element', 'listItem' ) ) {
			while ( listItem.getAttribute( 'listIndent' ) !== indent ) {
				listItem = listItem.previousSibling;
			}
		} else {
			listItem = null;
		}

		// Outdenting such a list should restore values based on `List item 4`.
		// ■ List item 1.[]
		//     ○ List item 2.
		//     ○ List item 3.
		// ■ List item 4.
		if ( !listItem ) {
			listItem = changedItems[ 0 ].nextSibling;

			while ( changedItems.includes( listItem ) && listItem.getAttribute( 'listIndent' ) === indent ) {
				listItem = listItem.nextSibling;
			}
		}

		// And such a list should not modify anything.
		// ■ List item 1.[]
		//     ○ List item 2.
		//     ○ List item 3.
		// "The later if check."
		if ( !listItem || !listItem.is( 'element', 'listItem' ) ) {
			return;
		}

		editor.model.change( writer => {
			const itemsToUpdate = changedItems.filter( item => item.getAttribute( 'listIndent' ) === indent );

			for ( const item of itemsToUpdate ) {
				writer.setAttribute( 'listStyle', listItem.getAttribute( 'listStyle' ), item );
			}
		} );
	};
}

// Each `listItem` element must have specified the `listStyle` attribute.
// This post-fixer checks whether inserted elements `listItem` elements should inherit the `listStyle` value from
// their sibling nodes or should use the default value.
//
// Paragraph[]
// ■ List item 1. // [listStyle="square", listType="bulleted"]
// ■ List item 2. // ...
// ■ List item 3. // ...
//
// editor.execute( 'bulletedList' )
//
// ■ Paragraph[]  // [listStyle="square", listType="bulleted"]
// ■ List item 1. // [listStyle="square", listType="bulleted"]
// ■ List item 2.
// ■ List item 3.
//
// It also covers a such change:
//
// [Paragraph 1
// Paragraph 2]
// ■ List item 1. // [listStyle="square", listType="bulleted"]
// ■ List item 2. // ...
// ■ List item 3. // ...
//
// editor.execute( 'numberedList' )
//
// 1. [Paragraph 1 // [listStyle="default", listType="numbered"]
// 2. Paragraph 2] // [listStyle="default", listType="numbered"]
// ■ List item 1.  // [listStyle="square", listType="bulleted"]
// ■ List item 2.  // ...
// ■ List item 3.  // ...
//
// @private
// @param {module:core/editor/editor~Editor} editor
// @returns {Function}
function fixListStyleAttributeOnListItemElements( editor ) {
	return writer => {
		let wasFixed = false;
		const insertedListItems = [];

		for ( const change of editor.model.document.differ.getChanges() ) {
			if ( change.type == 'insert' && change.name == 'listItem' ) {
				insertedListItems.push( change.position.nodeAfter );
			}
		}

		if ( !insertedListItems.length ) {
			return wasFixed;
		}

		const existingListItem = insertedListItems[ insertedListItems.length - 1 ].nextSibling;

		if ( !existingListItem ) {
			return wasFixed;
		}

		for ( const item of insertedListItems ) {
			if ( !item.hasAttribute( 'listStyle' ) ) {
				if ( existingListItem.getAttribute( 'listType' ) === item.getAttribute( 'listType' ) ) {
					writer.setAttribute( 'listStyle', existingListItem.getAttribute( 'listStyle' ), item );
				} else {
					writer.setAttribute( 'listStyle', DEFAULT_LIST_TYPE, item );
				}

				wasFixed = true;
			}
		}

		return wasFixed;
	};
}