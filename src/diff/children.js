import { diff, unmount, applyRef } from './index';
import { createVNode, Fragment } from '../create-element';
import {
	EMPTY_OBJ,
	EMPTY_ARR,
	INSERT_VNODE,
	MATCHED,
	UNDEFINED,
	NULL,
	HAS_MOVE_BEFORE_SUPPORT
} from '../constants';
import { isArray } from '../util';
import { getDomSibling } from '../component';

/**
 * @typedef {import('../internal').ComponentChildren} ComponentChildren
 * @typedef {import('../internal').Component} Component
 * @typedef {import('../internal').PreactElement} PreactElement
 * @typedef {import('../internal').VNode} VNode
 */

/**
 * Diff the children of a virtual node
 * @param {PreactElement} parentDom The DOM element whose children are being
 * diffed
 * @param {ComponentChildren[]} renderResult
 * @param {VNode} newParentVNode The new virtual node whose children should be
 * diff'ed against oldParentVNode
 * @param {VNode} oldParentVNode The old virtual node whose children should be
 * diff'ed against newParentVNode
 * @param {object} globalContext The current context object - modified by
 * getChildContext
 * @param {string} namespace Current namespace of the DOM node (HTML, SVG, or MathML)
 * @param {Array<PreactElement>} excessDomChildren
 * @param {Array<Component>} commitQueue List of components which have callbacks
 * to invoke in commitRoot
 * @param {PreactElement} oldDom The current attached DOM element any new dom
 * elements should be placed around. Likely `null` on first render (except when
 * hydrating). Can be a sibling DOM element when diffing Fragments that have
 * siblings. In most cases, it starts out as `oldChildren[0]._dom`.
 * @param {boolean} isHydrating Whether or not we are in hydration
 * @param {any[]} refQueue an array of elements needed to invoke refs
 * @param {Document} doc The document object to use for creating elements
 * @returns {PreactElement} The next sibling DOM element to insert new elements
 */
export function diffChildren(
	parentDom,
	renderResult,
	newParentVNode,
	oldParentVNode,
	globalContext,
	namespace,
	excessDomChildren,
	commitQueue,
	oldDom,
	isHydrating,
	refQueue,
	doc
) {
	let i,
		/** @type {VNode} */
		oldVNode,
		/** @type {VNode} */
		childVNode,
		/** @type {PreactElement} */
		newDom,
		/** @type {PreactElement} */
		firstChildDom;

	// This is a compression of oldParentVNode!=null && oldParentVNode != EMPTY_OBJ && oldParentVNode._children || EMPTY_ARR
	// as EMPTY_OBJ._children should be `undefined`.
	/** @type {VNode[]} */
	let oldChildren = (oldParentVNode && oldParentVNode._children) || EMPTY_ARR;

	let newChildrenLength = renderResult.length;

	oldDom = constructNewChildrenArray(
		newParentVNode,
		renderResult,
		oldChildren,
		oldDom,
		newChildrenLength
	);

	for (i = 0; i < newChildrenLength; i++) {
		childVNode = newParentVNode._children[i];
		if (childVNode == NULL) continue;

		// At this point, constructNewChildrenArray has assigned _index to be the
		// matchingIndex for this VNode's oldVNode (or -1 if there is no oldVNode).
		oldVNode =
			(childVNode._index != -1 && oldChildren[childVNode._index]) || EMPTY_OBJ;

		// Update childVNode._index to its final index
		childVNode._index = i;

		// Morph the old element into the new one, but don't append it to the dom yet
		let result = diff(
			parentDom,
			childVNode,
			oldVNode,
			globalContext,
			namespace,
			excessDomChildren,
			commitQueue,
			oldDom,
			isHydrating,
			refQueue,
			doc
		);

		// Adjust DOM nodes
		newDom = childVNode._dom;
		if (childVNode.ref && oldVNode.ref != childVNode.ref) {
			if (oldVNode.ref) {
				applyRef(oldVNode.ref, NULL, childVNode);
			}
			refQueue.push(
				childVNode.ref,
				childVNode._component || newDom,
				childVNode
			);
		}

		if (firstChildDom == NULL && newDom != NULL) {
			firstChildDom = newDom;
		}

		let shouldPlace = childVNode._flags & INSERT_VNODE;
		if (shouldPlace || oldVNode._children === childVNode._children) {
			oldDom = insert(
				childVNode,
				oldDom,
				parentDom,
				shouldPlace,
				oldVNode == NULL || oldVNode._original == NULL
			);

			// When a matched VNode is physically moved via INSERT_VNODE, its old
			// _dom pointer becomes a stale positional reference. Clear it so that
			// getDomSibling (called from nested diffs) won't return this stale
			// reference and mis-place subsequent DOM nodes. See #5065.
			if (shouldPlace && oldVNode._dom) {
				oldVNode._dom = NULL;
			}
		} else if (typeof childVNode.type == 'function' && result !== UNDEFINED) {
			oldDom = result;
		} else if (newDom) {
			oldDom = newDom.nextSibling;
		}

		// Unset diffing flags
		childVNode._flags &= ~(INSERT_VNODE | MATCHED);
	}

	newParentVNode._dom = firstChildDom;

	return oldDom;
}

/**
 * @param {VNode} newParentVNode
 * @param {ComponentChildren[]} renderResult
 * @param {VNode[]} oldChildren
 */
function constructNewChildrenArray(
	newParentVNode,
	renderResult,
	oldChildren,
	oldDom,
	newChildrenLength
) {
	/** @type {number} */
	let i;
	/** @type {VNode} */
	let childVNode;
	/** @type {VNode} */
	let oldVNode;
	/** @type {number | undefined} */
	let lo;
	/** @type {number} */
	let hi;
	/** @type {number} */
	let mid;
	/** @type {number[]} */
	let piles = [];

	let oldChildrenLength = oldChildren.length,
		remainingOldChildren = oldChildrenLength;

	let skew = 0;

	let children = (newParentVNode._children = new Array(newChildrenLength));
	for (i = 0; i < newChildrenLength; i++) {
		// @ts-expect-error We are reusing the childVNode variable to hold both the
		// pre and post normalized childVNode
		childVNode = renderResult[i];

		if (
			childVNode == NULL ||
			typeof childVNode == 'boolean' ||
			typeof childVNode == 'function'
		) {
			children[i] = NULL;
			continue;
		}
		// If this newVNode is being reused (e.g. <div>{reuse}{reuse}</div>) in the same diff,
		// or we are rendering a component (e.g. setState) copy the oldVNodes so it can have
		// it's own DOM & etc. pointers
		else if (
			typeof childVNode == 'string' ||
			typeof childVNode == 'number' ||
			// eslint-disable-next-line valid-typeof
			typeof childVNode == 'bigint' ||
			childVNode.constructor == String
		) {
			childVNode = children[i] = createVNode(
				NULL,
				childVNode,
				NULL,
				NULL,
				NULL
			);
		} else if (isArray(childVNode)) {
			childVNode = children[i] = createVNode(
				Fragment,
				{ children: childVNode },
				NULL,
				NULL,
				NULL
			);
		} else if (childVNode.constructor === UNDEFINED && childVNode._depth > 0) {
			// VNode is already in use, clone it. This can happen in the following
			// scenario:
			//   const reuse = <div />
			//   <div>{reuse}<span />{reuse}</div>
			childVNode = children[i] = createVNode(
				childVNode.type,
				childVNode.props,
				childVNode.key,
				childVNode.ref ? childVNode.ref : NULL,
				childVNode._original
			);
		} else {
			children[i] = childVNode;
		}

		const skewedIndex = i + skew;
		childVNode._parent = newParentVNode;

		// Reuse `childVNode._depth` for Longest Increasing Subsequence (LIS) calculations
		// for the duration of the current loop. The proper depth values will be restored
		// in the subsequent loop.
		//
		// The value is the length of the longest increasing subsequence ending at this
		// node, and is always > 0.
		//
		// Use `newChildrenLength` as a sentinel value for a node that was not in
		// consideration to be included in the LIS.
		//
		// The only case when a node in the LIS can have `._depth == newChildrenLength`
		// value after the current loop occurs is when *all* the nodes were in the LIS.
		// The subsequent loop handles that case before checking the, um, sentinel-ness.
		childVNode._depth = newChildrenLength;

		// Temporarily store the matchingIndex on the _index property so we can pull
		// out the oldVNode in diffChildren. We'll override this to the VNode's
		// final index after using this property to get the oldVNode
		const matchingIndex = (childVNode._index = findMatchingIndex(
			childVNode,
			oldChildren,
			skewedIndex,
			remainingOldChildren
		));

		if (matchingIndex == -1) {
			// When the array of children is growing we need to decrease the skew
			// as we are adding a new element to the array.
			// Example:
			// [1, 2, 3] --> [0, 1, 2, 3]
			// oldChildren   newChildren
			//
			// The new element is at index 0, so our skew is 0,
			// we need to decrease the skew as we are adding a new element.
			// The decrease will cause us to compare the element at position 1
			// with value 1 with the element at position 0 with value 0.
			//
			// A linear concept is applied when the array is shrinking,
			// if the length is unchanged we can assume that no skew
			// changes are needed.
			skew += Math.sign(oldChildrenLength - newChildrenLength);
		} else {
			oldVNode = oldChildren[matchingIndex];
			remainingOldChildren--;

			if (oldVNode != NULL) {
				oldVNode._flags |= MATCHED;

				// Nodes that are unsuspending (`oldVNode._original == null`) are considered mounting,
				// and skipped here.
				if (oldVNode._original != NULL) {
					// Always skew the next search max. 1 step towards the current match.
					//
					// To restore the previous heuristics, do this instead:
					//  if (matchingIndex == skewedIndex - 1) {
					//    skew--;
					//  } else if (matchingIndex == skewedIndex + 1) {
					//    skew++;
					//  } else {
					//    skew += Math.sign(skewedIndex - matchingIndex);
					//  }
					skew += Math.sign(matchingIndex - skewedIndex);

					// The previous iteration's `lo` value is preserved, allowing us to
					// reuse it as the lower bound in the binary search when the
					// matched index is larger than the previous one. Otherwise
					// start from zero.
					//
					// In cases where all matched indexes are increasing this
					// skips the binary search altogether.
					lo = lo && piles[lo - 1] < matchingIndex ? lo : 0;
					hi = piles.length;
					while (lo < hi) {
						// Assumes that `lo + hi` < 2^31, in which case `(lo + hi) >> 1` is safe.
						// If we can only assume `lo + hi` < 2^32, then use `(lo + hi) >>> 1`.
						// If even that doesn't hold, then go with `lo + ((hi - lo) >>> 1)`.
						mid = (lo + hi) >> 1;
						if (piles[mid] < matchingIndex) {
							lo = mid + 1;
						} else {
							hi = mid;
						}
					}
					piles[lo] = matchingIndex;
					childVNode._depth = ++lo;
				}
			}
		}
	}

	// Resolve which nodes belong in the longest increasing subsequence.
	hi = piles.length;
	while (i--) {
		childVNode = children[i];
		if (childVNode != NULL) {
			if (childVNode._depth === hi) {
				// This node is in the longest increasing subsequence, so it's already in the
				// correct relative position.
				hi--;
			} else if (
				childVNode._depth != newChildrenLength ||
				typeof childVNode.type != 'function'
			) {
				// Matched children not in the LIS (any type) and mounting/unsuspending
				// DOM VNodes get inserted. Mounting components do not, as their DOM nodes are
				// inserted during the subtree mount.
				childVNode._flags |= INSERT_VNODE;
			}
			// Restore ._depth as it's no longer needed for longest increasing subsequence bookkeeping.
			childVNode._depth = newParentVNode._depth + 1;
		}
	}

	// Remove remaining oldChildren if there are any. Loop forwards so that as we
	// unmount DOM from the beginning of the oldChildren, we can adjust oldDom to
	// point to the next child, which needs to be the first DOM node that won't be
	// unmounted.
	if (remainingOldChildren) {
		for (i = 0; i < oldChildrenLength; i++) {
			oldVNode = oldChildren[i];
			if (oldVNode != NULL && (oldVNode._flags & MATCHED) == 0) {
				if (oldVNode._dom == oldDom) {
					oldDom = getDomSibling(oldVNode);
				}

				unmount(oldVNode, oldVNode);
			}
		}
	}

	return oldDom;
}

/**
 * @param {VNode} parentVNode
 * @param {PreactElement} oldDom
 * @param {PreactElement} parentDom
 * @param {number} shouldPlace
 * @param {boolean} isMounting
 * @returns {PreactElement}
 */
function insert(parentVNode, oldDom, parentDom, shouldPlace, isMounting) {
	// Note: VNodes in nested suspended trees may be missing _children.
	if (typeof parentVNode.type == 'function') {
		// Root children live in another container, they never move with the
		// host tree and contribute nothing to the host insertion cursor.
		if (parentVNode.props._parentDom) return oldDom;
		let children = parentVNode._children;
		for (let i = 0; children && i < children.length; i++) {
			if (children[i]) {
				// If we enter this code path on sCU bailout, where we copy
				// oldVNode._children to newVNode._children, we need to update the old
				// children's _parent pointer to point to the newVNode (parentVNode
				// here).
				children[i]._parent = parentVNode;
				oldDom = insert(children[i], oldDom, parentDom, shouldPlace, false);
			}
		}

		return oldDom;
	} else if (parentVNode._dom != oldDom) {
		if (shouldPlace) {
			if (oldDom && parentVNode.type && !oldDom.parentNode) {
				oldDom = getDomSibling(parentVNode);
			}

			if (HAS_MOVE_BEFORE_SUPPORT && !isMounting) {
				// @ts-expect-error This isn't added to TypeScript lib.d.ts yet
				parentDom.moveBefore(parentVNode._dom, oldDom);
			} else {
				parentDom.insertBefore(parentVNode._dom, oldDom || NULL);
			}
		}
		oldDom = parentVNode._dom;
	}

	do {
		oldDom = oldDom && oldDom.nextSibling;
	} while (oldDom != NULL && oldDom.nodeType == 8);

	return oldDom;
}

/**
 * Flatten and loop through the children of a virtual node
 * @param {ComponentChildren} children The unflattened children of a virtual
 * node
 * @returns {VNode[]}
 */
export function toChildArray(children, out) {
	out = out || [];
	if (children == NULL || typeof children == 'boolean') {
	} else if (isArray(children)) {
		children.some(child => {
			toChildArray(child, out);
		});
	} else {
		out.push(children);
	}
	return out;
}

/**
 * @param {VNode} childVNode
 * @param {VNode[]} oldChildren
 * @param {number} skewedIndex
 * @param {number} remainingOldChildren
 * @returns {number}
 */
function findMatchingIndex(
	childVNode,
	oldChildren,
	skewedIndex,
	remainingOldChildren
) {
	const key = childVNode.key;
	const type = childVNode.type;
	let oldVNode = oldChildren[skewedIndex];
	const matched = oldVNode != NULL && (oldVNode._flags & MATCHED) == 0;

	// We only need to perform a search if there are more children
	// (remainingOldChildren) to search. However, if the oldVNode we just looked
	// at skewedIndex was not already used in this diff, then there must be at
	// least 1 other (so greater than 1) remainingOldChildren to attempt to match
	// against. So the following condition checks that ensuring
	// remainingOldChildren > 1 if the oldVNode is not already used/matched. Else
	// if the oldVNode was null or matched, then there could needs to be at least
	// 1 (aka `remainingOldChildren > 0`) children to find and compare against.
	//
	// If there is an unkeyed functional VNode, that isn't a built-in like our Fragment,
	// we should not search as we risk re-using state of an unrelated VNode. (reverted for now)
	let shouldSearch =
		// (typeof type != 'function' || type === Fragment || key) &&
		remainingOldChildren > (matched ? 1 : 0);

	if (
		(oldVNode === NULL && key == null) ||
		(matched && key == oldVNode.key && type == oldVNode.type)
	) {
		return skewedIndex;
	} else if (shouldSearch) {
		let x = skewedIndex - 1;
		let y = skewedIndex + 1;
		while (x >= 0 || y < oldChildren.length) {
			const childIndex = x >= 0 ? x-- : y++;
			oldVNode = oldChildren[childIndex];
			if (
				oldVNode != NULL &&
				(oldVNode._flags & MATCHED) == 0 &&
				key == oldVNode.key &&
				type == oldVNode.type
			) {
				return childIndex;
			}
		}
	}

	return -1;
}
