'use strict';

import {
	getFunctionName,
	getStaticProperty,
	isBoolean,
	isDefAndNotNull,
	isElement,
	isFunction,
	isObject,
	isString,
	object
} from 'metal';
import { DomEventEmitterProxy, toElement } from 'metal-dom';
import ComponentDataManager from './ComponentDataManager';
import ComponentRenderer from './ComponentRenderer';
import { EventEmitter, EventHandler } from 'metal-events';

/**
 * Component collects common behaviors to be followed by UI components, such
 * as Lifecycle, CSS classes management, events encapsulation and support for
 * different types of rendering.
 * Rendering logic can be done by either:
 *     - Listening to the `render` event inside the `created` lifecycle function
 *       and adding the rendering logic to the listener.
 *     - Using an existing implementation of `ComponentRenderer` like `Soy`,
 *       and following its patterns.
 *     - Building your own implementation of a `ComponentRenderer`.
 * Specifying the renderer that will be used can be done by setting the RENDERER
 * static variable to the renderer's constructor function.
 *
 * Example:
 *
 * <code>
 * class CustomComponent extends Component {
 *   constructor(config) {
 *     super(config);
 *   }
 *
 *   created() {
 *   }
 *
 *   rendered() {
 *   }
 *
 *   attached() {
 *   }
 *
 *   detached() {
 *   }
 * }
 *
 * CustomComponent.RENDERER = MyRenderer;
 *
 * CustomComponent.STATE = {
 *   title: { value: 'Title' },
 *   fontSize: { value: '10px' }
 * };
 * </code>
 *
 * @extends {State}
 */
class Component extends EventEmitter {
	/**
	 * Constructor function for `Component`.
	 * @param {Object=} opt_config An object with the initial values for this
	 *     component's state.
	 * @param {boolean|string|Element=} opt_parentElement The element where the
	 *     component should be rendered. Can be given as a selector or an element.
	 *     If `false` is passed, the component won't be rendered automatically
	 *     after created.
	 * @constructor
	 */
	constructor(opt_config, opt_parentElement) {
		super();

		/**
		 * Gets all nested components.
		 * @type {!Array<!Component>}
		 */
		this.components = {};

		/**
		 * Instance of `DomEventEmitterProxy` which proxies events from the component's
		 * element to the component itself.
		 * @type {!DomEventEmitterProxy}
		 * @protected
		 */
		this.elementEventProxy_ = new DomEventEmitterProxy(
			null,
			this,
			proxyBlackList_
		);

		/**
		 * The `EventHandler` instance for events attached from the `events` state key.
		 * @type {EventHandler}
		 * @protected
		 */
		this.eventsStateKeyHandler_ = null;

		/**
		 * Whether the element is in document.
		 * @type {boolean}
		 */
		this.inDocument = false;

		/**
		 * The initial config option passed to this constructor.
		 * @type {!Object}
		 * @protected
		 */
		this.initialConfig_ = opt_config || {};

		/**
		 * Whether the element was rendered.
		 * @type {boolean}
		 */
		this.wasRendered = false;

		/**
		 * The component's element will be appended to the element this variable is
		 * set to, unless the user specifies another parent when calling `render` or
		 * `attach`.
		 * @type {!Element}
		 */
		this.DEFAULT_ELEMENT_PARENT = document.body;

		this.setShouldUseFacade(true);
		this.element = this.initialConfig_.element;

		this.renderer_ = this.createRenderer();
		this.dataManager_ = getStaticProperty(this.constructor, 'DATA_MANAGER');
		this.dataManager_.setUp(
			this,
			object.mixin({}, this.renderer_.getExtraDataConfig(), Component.DATA)
		);

		this.syncUpdates_ = getStaticProperty(this.constructor, 'SYNC_UPDATES');
		if (this.hasSyncUpdates()) {
			this.on(
				'stateKeyChanged',
				this.handleComponentStateKeyChanged_.bind(this)
			);
		}

		this.on('stateChanged', this.handleComponentStateChanged_);
		this.on('eventsChanged', this.onEventsChanged_);
		this.addListenersFromObj_(this.dataManager_.get(this, 'events'));

		this.created();
		this.componentCreated_ = true;
		if (opt_parentElement !== false) {
			this.render_(opt_parentElement);
		}
	}

	/**
	 * Getter logic for the element property.
	 * @return {Element}
	 */
	get element() {
		return this.elementVal_;
	}

	/**
	 * Adds the listeners specified in the given object.
	 * @param {Object} events
	 * @protected
	 */
	addListenersFromObj_(events) {
		var eventNames = Object.keys(events || {});
		for (var i = 0; i < eventNames.length; i++) {
			var info = this.extractListenerInfo_(events[eventNames[i]]);
			if (info.fn) {
				var handler;
				if (info.selector) {
					handler = this.delegate(eventNames[i], info.selector, info.fn);
				} else {
					handler = this.on(eventNames[i], info.fn);
				}
				if (!this.eventsStateKeyHandler_) {
					this.eventsStateKeyHandler_ = new EventHandler();
				}
				this.eventsStateKeyHandler_.add(handler);
			}
		}
	}

	/**
	 * Invokes the attached Lifecycle. When attached, the component element is
	 * appended to the DOM and any other action to be performed must be
	 * implemented in this method, such as, binding DOM events. A component can
	 * be re-attached multiple times.
	 * @param {(string|Element)=} opt_parentElement Optional parent element
	 *     to render the component.
	 * @param {(string|Element)=} opt_siblingElement Optional sibling element
	 *     to render the component before it. Relevant when the component needs
	 *     to be rendered before an existing element in the DOM.
	 * @protected
	 * @chainable
	 */
	attach(opt_parentElement, opt_siblingElement) {
		if (!this.inDocument) {
			this.renderElement_(opt_parentElement, opt_siblingElement);
			this.inDocument = true;
			this.attachData_ = {
				parent: opt_parentElement,
				sibling: opt_siblingElement
			};
			this.emit('attached', this.attachData_);
			this.attached();
		}
		return this;
	}

	/**
	 * Lifecycle. When attached, the component element is appended to the DOM
	 * and any other action to be performed must be implemented in this method,
	 * such as, binding DOM events. A component can be re-attached multiple
	 * times, therefore the undo behavior for any action performed in this phase
	 * must be implemented on the detach phase.
	 */
	attached() {}

	/**
	 * Adds the given sub component, replacing any existing one with the same ref.
	 * @param {string} ref
	 * @param {!Component} component
	 */
	addSubComponent(ref, component) {
		this.components[ref] = component;
	}

	/**
	 * Lifecycle. This is called when the component has just been created, before
	 * it's rendered.
	 */
	created() {}

	/**
	 * Creates the renderer for this component. Sub classes can override this to
	 * return a custom renderer as needed.
	 * @return {!ComponentRenderer}
	 */
	createRenderer() {
		const RendererCtor = getStaticProperty(this.constructor, 'RENDERER');
		return new RendererCtor(this);
	}

	/**
	 * Listens to a delegate event on the component's element.
	 * @param {string} eventName The name of the event to listen to.
	 * @param {string} selector The selector that matches the child elements that
	 *   the event should be triggered for.
	 * @param {!function(!Object)} callback Function to be called when the event is
	 *   triggered. It will receive the normalized event object.
	 * @return {!EventHandle} Can be used to remove the listener.
	 */
	delegate(eventName, selector, callback) {
		return this.on('delegate:' + eventName + ':' + selector, callback);
	}

	/**
	 * Invokes the detached Lifecycle. When detached, the component element is
	 * removed from the DOM and any other action to be performed must be
	 * implemented in this method, such as, unbinding DOM events. A component
	 * can be detached multiple times.
	 * @chainable
	 */
	detach() {
		if (this.inDocument) {
			if (this.element && this.element.parentNode) {
				this.element.parentNode.removeChild(this.element);
			}
			this.inDocument = false;
			this.detached();
		}
		this.emit('detached');
		return this;
	}

	/**
	 * Lifecycle. When detached, the component element is removed from the DOM
	 * and any other action to be performed must be implemented in this method,
	 * such as, unbinding DOM events. A component can be detached multiple
	 * times, therefore the undo behavior for any action performed in this phase
	 * must be implemented on the attach phase.
	 */
	detached() {}

	/**
	 * Lifecycle. Called when the component is disposed. Should be overridden by
	 * sub classes to dispose of any internal data or events.
	 */
	disposed() {}

	/**
	 * @inheritDoc
	 */
	disposeInternal() {
		this.disposed();

		this.detach();

		this.elementEventProxy_.dispose();
		this.elementEventProxy_ = null;

		this.disposeSubComponents(Object.keys(this.components));
		this.components = null;

		this.dataManager_.dispose(this);
		this.dataManager_ = null;

		this.renderer_.dispose();
		this.renderer_ = null;

		super.disposeInternal();
	}

	/**
	 * Calls `dispose` on all subcomponents.
	 * @param {!Array<string>} keys
	 */
	disposeSubComponents(keys) {
		for (var i = 0; i < keys.length; i++) {
			var component = this.components[keys[i]];
			if (component && !component.isDisposed()) {
				component.element = null;
				component.dispose();
				delete this.components[keys[i]];
			}
		}
	}

	/**
	 * Extracts listener info from the given value.
	 * @param {function()|string|{selector:string,fn:function()|string}} value
	 * @return {!{selector:string,fn:function()}}
	 * @protected
	 */
	extractListenerInfo_(value) {
		var info = {
			fn: value
		};
		if (isObject(value) && !isFunction(value)) {
			info.selector = value.selector;
			info.fn = value.fn;
		}
		if (isString(info.fn)) {
			info.fn = this.getListenerFn(info.fn);
		}
		return info;
	}

	/**
	 * Gets data about where this component was attached at.
	 * @return {!Object}
	 */
	getAttachData() {
		return this.attachData_;
	}

	/**
	 * Gets the `ComponentDataManager` being used.
	 * @return {!ComponentDataManager}
	 */
	getDataManager() {
		return this.dataManager_;
	}

	/**
	 * Gets the configuration object that was passed to this component's constructor.
	 * @return {!Object}
	 */
	getInitialConfig() {
		return this.initialConfig_;
	}

	/**
	 * Gets the listener function from its name. If the name is prefixed with a
	 * component id, the function will be called on that specified component. Otherwise
	 * it will be called on this component instead.
	 * @param {string} fnName
	 * @return {function()}
	 */
	getListenerFn(fnName) {
		if (isFunction(this[fnName])) {
			return this[fnName].bind(this);
		} else {
			console.error('No function named "' + fnName + '" was found in the ' +
				'component "' + getFunctionName(this.constructor) + '". Make ' +
				'sure that you specify valid function names when adding inline listeners.'
			);
		}
	}

	/**
	 * Gets state data for this component.
	 * @return {!Object}
	 */
	getState() {
		return this.dataManager_.getState(this);
	}

	/**
	 * Gets the keys for the state data.
	 * @return {!Array<string>}
	 */
	getStateKeys() {
		return this.dataManager_.getStateKeys(this);
	}

	/**
	 * Gets the `sync` methods for this component's state.
	 * @return {!Object}
	 * @protected
	 */
	getSyncFns_() {
		const ctor = this.constructor;
		if (!ctor.hasOwnProperty('__METAL_SYNC_FNS__')) {
			const fns = {};
			const keys = this.dataManager_.getSyncKeys(this);
			let shouldCache = true;
			for (let i = 0; i < keys.length; i++) {
				const name = 'sync' + keys[i].charAt(0).toUpperCase() + keys[i].slice(1);
				const fn = ctor.prototype[name] || this[name];
				if (fn) {
					fns[keys[i]] = fn;
					shouldCache = shouldCache && ctor.prototype[name];
				}
			}
			if (!shouldCache) {
				return fns;
			}
			ctor.__METAL_SYNC_FNS__ = fns;
		}
		return ctor.__METAL_SYNC_FNS__;
	}

	/**
	 * Calls the synchronization function for the state key.
	 * @param {string} key
	 * @param {Object.<string, Object>=} opt_change Object containing newVal and
	 *     prevVal keys.
	 * @protected
	 */
	fireStateKeyChange_(key, opt_change) {
		var fn = this.getSyncFns_()[key];
		if (isFunction(fn)) {
			if (!opt_change) {
				var manager = this.getDataManager();
				opt_change = {
					newVal: manager.get(this, key),
					prevVal: undefined
				};
			}
			fn.call(this, opt_change.newVal, opt_change.prevVal);
		}
	}

	/**
	 * Gets the `ComponentRenderer` instance being used.
	 * @return {!ComponentRenderer}
	 */
	getRenderer() {
		return this.renderer_;
	}

	/**
	 * Handles state batch changes. Calls any existing `sync` functions that
	 * match the changed state keys.
	 * @param {Event} event
	 * @protected
	 */
	handleComponentStateChanged_(event) {
		if (!this.hasSyncUpdates() && !this.skipUpdates_) {
			this.getRenderer().sync(event);
		}
		this.syncStateFromChanges_(event.changes);
		this.emit('stateSynced', event);
	}

	/**
	 * Handles a `stateKeyChanged` event. This is only called for components that
	 * have requested updates to happen synchronously.
	 * @param {!{key: string, newVal: *, prevVal: *}} data
	 * @protected
	 */
	handleComponentStateKeyChanged_(data) {
		if (!this.skipUpdates_) {
			this.getRenderer().sync({
				changes: {
					[data.key]: data
				}
			});
		}
	}

	/**
	 * Checks if this component has sync updates enabled.
	 * @return {boolean}
	 */
	hasSyncUpdates() {
		return this.syncUpdates_;
	}

	/**
	 * Checks if the given function is a component constructor.
	 * @param {!function()} fn Any function
	 * @return {boolean}
	 */
	static isComponentCtor(fn) {
		return fn.prototype && fn.prototype[Component.COMPONENT_FLAG];
	}

	/**
	 * Merges two values for the ELEMENT_CLASSES property into a single one.
	 * @param {string} val1
	 * @param {string} val2
	 * @return {string} The merged value.
	 * @protected
	 */
	mergeElementClasses_(val1, val2) {
		return val1 ? val1 + ' ' + (val2 || '') : val2;
	}

	/**
	 * Fired when the `events` state value is changed.
	 * @param {!Object} event
	 * @protected
	 */
	onEventsChanged_(event) {
		if (this.eventsStateKeyHandler_) {
			this.eventsStateKeyHandler_.removeAllListeners();
		}
		this.addListenersFromObj_(event.newVal);
	}

	/**
	 * Creates and renders a component for the given constructor function. This
	 * will always make sure that the constructor runs without rendering the
	 * component, having the `render` step happen only after it has finished.
	 * @param {!function()} Ctor The component's constructor function.
	 * @param {Object|Element=} opt_configOrElement Optional config data or parent
	 *     for the component.
	 * @param {Element=} opt_element Optional parent for the component.
	 * @return {!Component} The rendered component's instance.
	 */
	static render(Ctor, opt_configOrElement, opt_element) {
		var config = opt_configOrElement;
		var element = opt_element;
		if (isElement(opt_configOrElement)) {
			config = null;
			element = opt_configOrElement;
		}
		var instance = new Ctor(config, false);
		instance.render_(element);
		return instance;
	}

	/**
	 * Lifecycle. Renders the component into the DOM.
	 *
	 * Render Lifecycle:
	 *   render event - The "render" event is emitted. Renderers act on this step.
	 *   state synchronization - All synchronization methods are called.
	 *   attach - Attach Lifecycle is called.
	 *
	 * @param {(string|Element|boolean)=} opt_parentElement Optional parent element
	 *     to render the component. If set to `false`, the element won't be
	 *     attached to any element after rendering. In this case, `attach` should
	 *     be called manually later to actually attach it to the dom.
	 * @param {boolean=} opt_skipRender Optional flag indicating that the actual
	 *     rendering should be skipped. Only the other render lifecycle logic will
	 *     be run, like syncing state and attaching the element. Should only
	 *     be set if the component has already been rendered, like sub components.
	 * @protected
	 */
	render_(opt_parentElement, opt_skipRender) {
		if (!opt_skipRender) {
			this.getRenderer().render();
			this.emit('render');
		}
		this.syncState_();
		this.attach(opt_parentElement);
		this.wasRendered = true;
	}

	/**
	 * Renders this component as a subcomponent, meaning that no actual rendering is
	 * needed since it was already rendered by the parent component. This just handles
	 * other logics from the rendering lifecycle, like calling sync methods for the
	 * state.
	 */
	renderAsSubComponent() {
		this.render_(null, true);
	}

	/**
	 * Renders the component element into the DOM.
	 * @param {(string|Element)=} opt_parentElement Optional parent element
	 *     to render the component.
	 * @param {(string|Element)=} opt_siblingElement Optional sibling element
	 *     to render the component before it. Relevant when the component needs
	 *     to be rendered before an existing element in the DOM, e.g.
	 *     `component.attach(null, existingElement)`.
	 * @protected
	 */
	renderElement_(opt_parentElement, opt_siblingElement) {
		var element = this.element;
		if (element && (opt_siblingElement || !element.parentNode)) {
			var parent = toElement(opt_parentElement) || this.DEFAULT_ELEMENT_PARENT;
			parent.insertBefore(element, toElement(opt_siblingElement));
		}
	}

	/**
	 * Setter logic for the element property.
	 * @param {?string|Element} val
	 */
	set element(val) {
		if (!isElement(val) && !isString(val) && isDefAndNotNull(val)) {
			return;
		}

		if (val) {
			val = toElement(val) || this.elementVal_;
		}

		if (this.elementVal_ !== val) {
			var prev = this.elementVal_;
			this.elementVal_ = val;
			this.elementEventProxy_.setOriginEmitter(val);
			if (this.componentCreated_) {
				this.emit('elementChanged', {
					prevVal: prev,
					newVal: val
				});
				if (val && this.wasRendered) {
					this.syncVisible(this.dataManager_.get(this, 'visible'));
				}
			}
		}
	}

	/**
	 * Sets the value of all the specified state keys.
	 * @param {!Object.<string,*>} values A map of state keys to the values they
	 *   should be set to.
	 * @param {function()=} opt_callback An optional function that will be run
	 *   after the next batched update is triggered.
	 */
	setState(state, opt_callback) {
		this.dataManager_.setState(this, state, opt_callback);
	}

	/**
	 * Setter for the `elementClasses` data property. Appends given value with
	 * the one specified in `ELEMENT_CLASSES`.
	 * @param {string} val
	 * @return {string}
	 * @protected
	 */
	setterElementClassesFn_(val) {
		const elementClasses = getStaticProperty(
			this.constructor,
			'ELEMENT_CLASSES',
			this.mergeElementClasses_
		);
		if (elementClasses) {
			val += ' ' + elementClasses;
		}
		return val.trim();
	}

	/**
	 * Skips updates until `stopSkipUpdates` is called.
	 */
	startSkipUpdates() {
		this.skipUpdates_ = true;
	}

	/**
	 * Stops skipping updates.
	 */
	stopSkipUpdates() {
		this.skipUpdates_ = false;
	}

	/**
	 * Fires state synchronization functions.
	 * @protected
	 */
	syncState_() {
		const keys = Object.keys(this.getSyncFns_());
		for (var i = 0; i < keys.length; i++) {
			this.fireStateKeyChange_(keys[i]);
		}
	}

	/**
	 * Fires synchronization changes for state keys.
	 * @param {Object.<string, Object>} changes Object containing the state key
	 *     name as key and an object with newVal and prevVal as value.
	 * @protected
	 */
	syncStateFromChanges_(changes) {
		for (var key in changes) {
			this.fireStateKeyChange_(key, changes[key]);
		}
	}

	/**
	 * State synchronization logic for `visible` state key.
	 * Updates the element's display value according to its visibility.
	 * @param {boolean} newVal
	 */
	syncVisible(newVal) {
		if (this.element) {
			this.element.style.display = newVal ? '' : 'none';
		}
	}

	/**
	 * Lifecycle. Called whenever the component has just been rendered.
	 * @param {boolean} firstRender Flag indicating if this was the component's
	 *     first render.
	 */
	rendered() {}

	/**
	 * Validator logic for the `events` state key.
	 * @param {Object} val
	 * @return {boolean}
	 * @protected
	 */
	validatorEventsFn_(val) {
		return !isDefAndNotNull(val) || isObject(val);
	}
}

/**
 * Component data definition.
 * @type {Object}
 * @static
 */
Component.DATA = {
	/**
	 * Objects describing children elements that were passed to be rendered inside
	 * this component.
	 * @type {!Array<!Object>}
	 */
	children: {
		validator: Array.isArray,
		value: []
	},

	/**
	 * CSS classes to be applied to the element.
	 * @type {string}
	 */
	elementClasses: {
		setter: 'setterElementClassesFn_',
		validator: isString,
		value: ''
	},

	/**
	 * Listeners that should be attached to this component. Should be provided as an object,
	 * where the keys are event names and the values are the listener functions (or function
	 * names).
	 * @type {Object<string, (function()|string|{selector: string, fn: function()|string})>}
	 */
	events: {
		validator: 'validatorEventsFn_',
		value: null
	},

	/**
	 * Indicates if the component is visible or not.
	 * @type {boolean}
	 */
	visible: {
		validator: isBoolean,
		value: true
	}
};

/**
 * Name of the flag used to identify component constructors via their prototype.
 * @type {string}
 */
Component.COMPONENT_FLAG = '__metal_component__';

/**
 * The `ComponentDataManager` class that should be used. This class will be
 * responsible for handling the component's data. Each component may have its
 * own implementation.
 */
Component.DATA_MANAGER = ComponentDataManager;

/**
 * CSS classes to be applied to the element.
 * @type {string}
 * @protected
 * @static
 */
Component.ELEMENT_CLASSES = '';

/**
 * The `ComponentRenderer` that should be used. Components need to set this
 * to a subclass of `ComponentRenderer` that has the rendering logic, like
 * `SoyRenderer`.
 * @type {!ComponentRenderer}
 * @static
 */
Component.RENDERER = ComponentRenderer;

/**
 * Flag indicating if component updates will happen synchronously. Updates are
 * done asynchronously by default, which allows changes to be batched and
 * applied together.
 * @type {boolean}
 */
Component.SYNC_UPDATES = false;

/**
 * Sets a prototype flag to easily determine if a given constructor is for
 * a component or not.
 */
Component.prototype[Component.COMPONENT_FLAG] = true;

const proxyBlackList_ = {
	eventsChanged: true,
	stateChanged: true,
	stateKeyChanged: true
};

export default Component;
