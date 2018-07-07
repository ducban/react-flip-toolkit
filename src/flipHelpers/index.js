import * as Rematrix from "rematrix"
import springUpdate from "./springUpdate"
import tweenUpdate from "./tweenUpdate"
import { parseMatrix, convertMatrix3dArrayTo2dString } from "./matrixHelpers"

const toArray = arrayLike => Array.prototype.slice.apply(arrayLike)

const isFunction = x => typeof x === "function"

const getInvertedChildren = (element, id) =>
  toArray(element.querySelectorAll(`[data-inverse-flip-id="${id}"]`))

const passesComponentFilter = (flipFilters, flipId) => {
  if (typeof flipFilters === "string") {
    if (flipFilters !== flipId) return false
  } else if (Array.isArray(flipFilters)) {
    if (!flipFilters.some(f => f === flipId)) {
      return false
    }
  }
  return true
}

export const shouldApplyTransform = (
  flipComponentIdFilter,
  flipStartId,
  flipEndId
) => {
  if (
    flipComponentIdFilter &&
    !passesComponentFilter(flipComponentIdFilter, flipStartId) &&
    !passesComponentFilter(flipComponentIdFilter, flipEndId)
  ) {
    return false
  }
  return true
}

// if we're scaling an element and we have element children with data-inverse-flip-ids,
// apply the inverse of the transforms so that the children don't distort
const invertTransformsForChildren = ({
  invertedChildren,
  matrix,
  body,
  flipStartId,
  flipEndId
}) => {
  invertedChildren.forEach(([child, childFlipConfig]) => {
    if (
      !shouldApplyTransform(
        childFlipConfig.componentIdFilter,
        flipStartId,
        flipEndId
      )
    )
      return

    if (!body.contains(child)) {
      return
    }

    const matrixVals = parseMatrix(matrix)

    const scaleX = matrixVals[0]
    const scaleY = matrixVals[3]
    const translateX = matrixVals[4]
    const translateY = matrixVals[5]

    const inverseVals = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1 }
    let transformString = ""
    if (childFlipConfig.translate) {
      inverseVals.translateX = -translateX / scaleX
      inverseVals.translateY = -translateY / scaleY
      transformString += `translate(${inverseVals.translateX}px, ${
        inverseVals.translateY
      }px)`
    }
    if (childFlipConfig.scale) {
      inverseVals.scaleX = 1 / scaleX
      inverseVals.scaleY = 1 / scaleY
      transformString += ` scale(${inverseVals.scaleX}, ${inverseVals.scaleY})`
    }
    child.style.transform = transformString
  })
}

const createApplyStylesFunc = ({
  element,
  invertedChildren,
  body,
  flipStartId,
  flipEndId
}) => ({ matrix, opacity }) => {
  element.style.transform = matrix
  element.style.opacity = opacity

  invertTransformsForChildren({
    invertedChildren,
    matrix,
    body,
    flipStartId,
    flipEndId
  })
}

export const getFlippedElementPositions = ({
  element,
  flipCallbacks,
  inProgressAnimations,
  beforeUpdate = false
}) => {
  const flippedElements = toArray(element.querySelectorAll("[data-flip-id]"))
  const inverseFlippedElements = toArray(
    element.querySelectorAll("[data-inverse-flip-id")
  )

  const childIdsToParentBCRs = {}

  // this is being called at getSnapshotBeforeUpdate
  if (beforeUpdate) {
    const parentBCRs = []
    // this is for exit animations so we can re-insert exiting elements in the
    // DOM later
    flippedElements
      .filter(
        el =>
          flipCallbacks &&
          flipCallbacks[el.dataset.flipId] &&
          flipCallbacks[el.dataset.flipId].onExit
      )
      .forEach(el => {
        const parent = el.parentNode
        let bcrIndex = parentBCRs.findIndex(n => n[0] === parent)
        if (bcrIndex === -1) {
          parentBCRs.push([parent, parent.getBoundingClientRect()])
          bcrIndex = parentBCRs.length - 1
        }
        childIdsToParentBCRs[el.dataset.flipId] = parentBCRs[bcrIndex][1]
      })
  }
  const flippedElementPositions = flippedElements
    .map(child => {
      let domData = {}
      const childBCR = child.getBoundingClientRect()

      if (
        beforeUpdate &&
        flipCallbacks &&
        flipCallbacks[child.dataset.flipId] &&
        flipCallbacks[child.dataset.flipId].onExit
      ) {
        const parentBCR = childIdsToParentBCRs[child.dataset.flipId]

        Object.assign(domData, {
          element: child,
          parent: child.parentNode,
          childPosition: {
            top: childBCR.top - parentBCR.top,
            left: childBCR.left - parentBCR.left,
            width: childBCR.width,
            height: childBCR.height
          }
        })
      }

      return [
        child.dataset.flipId,
        {
          rect: childBCR,
          opacity: parseFloat(window.getComputedStyle(child).opacity),
          flipComponentId: child.dataset.flipComponentId,
          domData
        }
      ]
    })
    .reduce((acc, curr) => ({ ...acc, [curr[0]]: curr[1] }), {})

  // do this at the very end since cancellation might cause some elements to be removed
  if (beforeUpdate) {
    flippedElements.concat(inverseFlippedElements).forEach(el => {
      el.style.transform = ""
      el.style.opacity = ""
    })
    cancelInProgressAnimations(inProgressAnimations)
  }

  return flippedElementPositions
}

export const rectInViewport = ({ top, bottom, left, right }) => {
  return (
    top < window.innerHeight &&
    bottom > 0 &&
    left < window.innerWidth &&
    right > 0
  )
}

const cancelInProgressAnimations = inProgressAnimations => {
  Object.keys(inProgressAnimations).forEach(id => {
    if (inProgressAnimations[id].stop) inProgressAnimations[id].stop()
  })
}

export const animateMove = ({
  inProgressAnimations,
  cachedFlipChildrenPositions = {},
  flipCallbacks = {},
  containerEl,
  duration,
  ease,
  applyTransformOrigin,
  spring,
  debug
}) => {
  const body = document.querySelector("body")

  const newFlipChildrenPositions = getFlippedElementPositions({
    element: containerEl,
    flipCallbacks,
    inProgressAnimations: undefined
  })

  const getElement = id => containerEl.querySelector(`*[data-flip-id="${id}"]`)
  const isFlipped = id =>
    cachedFlipChildrenPositions[id] && newFlipChildrenPositions[id]

  // animate in any entering non-flipped elements that requested it
  Object.keys(newFlipChildrenPositions)
    .filter(id => !isFlipped(id))
    // filter to only brand new elements with an onAppear callback
    .filter(
      id =>
        newFlipChildrenPositions[id] &&
        flipCallbacks[id] &&
        flipCallbacks[id].onAppear
    )
    .forEach((id, i) => {
      const element = getElement(id)
      // kind of hacky since it ignores inverted children
      // but they probably wont be used for appear transitions anyway
      if (applyTransformOrigin) {
        element.style.transformOrigin = "0 0"
      }
      flipCallbacks[id].onAppear(element, i)
    })

  // animate out any exiting non-flipped elements that requested it
  Object.keys(cachedFlipChildrenPositions)
    .filter(id => !isFlipped(id))
    // filter to only exited elements with an onExit callback
    .filter(
      id =>
        cachedFlipChildrenPositions[id] &&
        flipCallbacks[id] &&
        flipCallbacks[id].onExit
    )
    .forEach((id, i) => {
      const {
        domData: {
          element,
          parent,
          childPosition: { top, left, width, height }
        }
      } = cachedFlipChildrenPositions[id]
      // insert back into dom
      if (getComputedStyle(parent).position === "static") {
        parent.style.position = "relative"
      }
      element.style.position = "absolute"
      element.style.top = top + "px"
      element.style.left = left + "px"
      element.style.height = height + "px"
      element.style.width = width + "px"
      parent.appendChild(element)

      const stop = () => {
        try {
          parent.removeChild(element)
        } catch (DOMException) {
          //hmm
        }
      }
      flipCallbacks[id].onExit(element, i, stop)
      inProgressAnimations[id] = { stop }
    })

  if (debug) {
    console.error(
      'The "debug" prop is set to true. All FLIP animations will return at the beginning of the transition.'
    )
  }

  Object.keys(newFlipChildrenPositions)
    .filter(isFlipped)
    .forEach(id => {
      const prevRect = cachedFlipChildrenPositions[id].rect
      const currentRect = newFlipChildrenPositions[id].rect
      const prevOpacity = cachedFlipChildrenPositions[id].opacity
      const currentOpacity = newFlipChildrenPositions[id].opacity
      // don't animate invisible elements
      if (!rectInViewport(prevRect) && !rectInViewport(currentRect)) {
        return
      }
      // don't animate elements that didn't change
      if (
        prevRect.left === currentRect.left &&
        prevRect.top === currentRect.top &&
        prevRect.width === currentRect.width &&
        prevRect.height === currentRect.height &&
        prevOpacity === currentOpacity
      ) {
        return
      }

      const element = getElement(id)

      // this could happen if we are rapidly adding & removing elements
      if (!element) return

      const flipConfig = JSON.parse(element.dataset.flipConfig)

      const flipStartId = cachedFlipChildrenPositions[id].flipComponentId
      const flipEndId = flipConfig.componentId

      if (
        !shouldApplyTransform(
          flipConfig.componentIdFilter,
          flipStartId,
          flipEndId
        )
      )
        return

      const currentTransform = Rematrix.parse(
        getComputedStyle(element).transform
      )

      const toVals = { matrix: currentTransform, opacity: 1 }

      const fromVals = { opacity: 1 }
      const transformsArray = [currentTransform]

      // we're only going to animate the values that the child wants animated
      if (flipConfig.translate) {
        transformsArray.push(
          Rematrix.translateX(prevRect.left - currentRect.left)
        )
        transformsArray.push(
          Rematrix.translateY(prevRect.top - currentRect.top)
        )
      }

      if (flipConfig.scale) {
        transformsArray.push(
          Rematrix.scaleX(prevRect.width / Math.max(currentRect.width, 0.01))
        )
        transformsArray.push(
          Rematrix.scaleY(prevRect.height / Math.max(currentRect.height, 0.01))
        )
      }

      if (flipConfig.opacity) {
        fromVals.opacity = prevOpacity
        toVals.opacity = currentOpacity
      }

      if (flipConfig.transformOrigin) {
        element.style.transformOrigin = flipConfig.transformOrigin
      } else if (applyTransformOrigin) {
        element.style.transformOrigin = "0 0"
      }

      // we're going to pass around the children in this weird [child, childData]
      // structure because we only want to parse the children's config data 1x
      const invertedChildren = getInvertedChildren(element, id).map(c => [
        c,
        JSON.parse(c.dataset.flipConfig)
      ])

      invertedChildren.forEach(([child, childFlipConfig]) => {
        if (childFlipConfig.transformOrigin) {
          child.style.transformOrigin = childFlipConfig.transformOrigin
        } else if (applyTransformOrigin) {
          child.style.transformOrigin = "0 0"
        }
      })

      fromVals.matrix = transformsArray.reduce(Rematrix.multiply)

      // prepare for animation by turning matrix into a string
      fromVals.matrix = convertMatrix3dArrayTo2dString(fromVals.matrix)
      toVals.matrix = convertMatrix3dArrayTo2dString(toVals.matrix)

      const applyStyles = createApplyStylesFunc({
        element,
        invertedChildren,
        body,
        flipStartId,
        flipEndId
      })

      // before animating, immediately apply FLIP styles to prevent flicker
      applyStyles({
        matrix: fromVals.matrix,
        opacity: fromVals.opacity
      })

      if (debug) return

      if (flipCallbacks[id] && flipCallbacks[id].onStart)
        flipCallbacks[id].onStart(element, flipStartId)

      let onComplete
      if (flipCallbacks[id] && flipCallbacks[id].onComplete) {
        onComplete = () => flipCallbacks[id].onComplete(element, flipStartId)
      }

      const delay = parseFloat(flipConfig.delay)

      const getOnUpdateFunc = stop => ({ matrix, opacity }) => {
        if (!body.contains(element)) {
          stop()
          return
        }
        applyStyles({
          matrix,
          opacity
        })
      }

      let stop

      // this should be called when animation ends naturally
      // but also when it is interrupted
      const onAnimationEnd = () => {
        delete inProgressAnimations[id]
        isFunction(onComplete) && onComplete()
      }

      let easingType
      if (flipConfig.spring) easingType = "spring"
      else if (flipConfig.ease) easingType = "tween"
      else if (ease) easingType = "tween"
      else easingType = "spring"

      if (easingType === "spring") {
        stop = springUpdate({
          fromVals,
          toVals,
          delay,
          getOnUpdateFunc,
          onAnimationEnd,
          springConfig: flipConfig.spring || spring
        })
      } else {
        stop = tweenUpdate({
          fromVals,
          toVals,
          duration: parseFloat(flipConfig.duration || duration),
          easing: flipConfig.ease || ease,
          delay,
          getOnUpdateFunc,
          onAnimationEnd
        })
      }

      // in case we have to cancel
      inProgressAnimations[id] = {
        stop,
        onComplete
      }
    })
}